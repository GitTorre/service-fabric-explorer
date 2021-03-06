//-----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation.  All rights reserved.
// Licensed under the MIT License. See License file under the project root for license information.
//-----------------------------------------------------------------------------

/// <reference path="./@types/common.d.ts" />

import * as gulp from "gulp";
import * as gutil from "gulp-util";
import * as tslint from "tslint";
import gtslint from "gulp-tslint";
import * as fs from "fs";
import * as path from "path";
import * as del from "del";
import * as pify from "pify";
import * as runSequence from "run-sequence";
import * as child_process from "child_process";
import * as packager from "electron-packager";
import * as semver from "semver";
import * as https from "https";
import * as url from "url";
import * as ts from "typescript";
import * as globby from "globby";

import * as tsc from "./.build/tsc";

const pified_exec = pify(child_process.exec, { multiArgs: true });

declare global {
    interface StringConstructor {
        format: (format: string, ...args: Array<any>) => string;
    }
}

function isObject(value: any): value is object | Object {
    return typeof value === "object" && value !== null;
}

function isNullOrUndefined(value: any): value is null | undefined {
    return value === null || value === undefined;
}

function isString(value: any): value is string | String {
    return typeof value === "string" || value instanceof String;
}

function isFunction(value: any): value is Function {
    return typeof value === "function";
}

String.format = (format, ...args) => {
    if (!isString(format)) {
        throw new Error("format must be a string");
    }

    if (!Array.isArray(args)) {
        throw new Error("args must be an array.");
    }

    if (isNullOrUndefined(args)) {
        return format;
    }

    let matchIndex = -1;

    return format.replace(/(\{*)(\{(\d*)\})/gi, (substring, escapeChar: string, argIdentifier: string, argIndexStr: string) => {
        matchIndex++;

        if (escapeChar.length > 0) {
            return argIdentifier;
        }

        let argIndex = argIndexStr.length === 0 ? matchIndex : parseInt(argIndexStr, 10);

        if (isNaN(argIndex) || argIndex < 0 || argIndex >= args.length) {
            throw new Error(String.format("Referenced arg index, '{}',is out of range of the args.", argIndexStr));
        }

        return args[argIndex];
    });
};

enum Architecture {
    X86 = "x86",
    X64 = "x64"
}

enum Platform {
    Windows = "windows",
    Linux = "linux",
    MacOs = "macos"
}

interface IPackageInfo {
    x86?: string;
    x64?: string;
}

interface IVersionInfo {
    version: string | String;
    description?: string | String;

    linux?: IPackageInfo | string | String;
    windows?: IPackageInfo | string | String;
    macos?: IPackageInfo | string | String;
}

interface IBuildTarget {
    archs: Array<Architecture>
}

interface IBuildPaths {
    [key: string]: string;

    buildDir: string;
    publishDir: string;
    appDir: string;
    sfxDir: string;
}

interface IBuildLicensing {
    apis: {
        usages: {
            url: string;
            method: string;
        }
    };
    group: string;
    project: string;
    thirdPartyNoticesFileName: string;
    packageLicenses: IDictionary<string>
}

interface IUpdateInfos {
    baseUrl: string;
    packageInfos: IDictionary<IPackageInfo | string>
}

interface IBuildInfos {
    productName: string;
    description: string;
    copyright: string;
    targetExecutableName: string;
    appId: string,
    appCategory: string,
    buildNumber: string;
    updateInfos: IUpdateInfos;
    targets: IDictionary<IBuildTarget>;
    paths: IBuildPaths;
    licensing: IBuildLicensing;
}

interface ISfxDependency {
    version: string;
    dependencyTypes: Array<"dev" | "prod">;
    platform: Platform;
}

interface IPackageJson {
    name: string;
    version: string;
    homepage: string;
    license?: string;
}

interface INpmJson extends IPackageJson {
    devDependencies: IDictionary<string>;
    dependencies: IDictionary<string>;
    optionalDependencies: IDictionary<string>;

    peerDependencies: IDictionary<string>;
    bundleDependencies: IDictionary<string>;
    extensionDependencies: IDictionary<string>;
    sfxDependencies: IDictionary<ISfxDependency>;
}

interface ILicense {
    spdxId: string;
    getLicenseText(): string;
}

interface ILicensingDependency {
    name: string;
    version: string;
    homepage: string;
    license: ILicense;
    depType?: "dev" | "prod";
}

abstract class License implements ILicense {
    public readonly spdxId: string;

    constructor(spdxId: string) {
        if (isNullOrUndefined(spdxId) || spdxId.trim() === "") {
            throw Error("spdxId should not be null/undefined/empty.");
        }

        this.spdxId = spdxId;
    }

    abstract getLicenseText(): string;
}

class FileLicense extends License {
    protected readonly licensePath: string;

    constructor(spdxId: string, licensePath: string) {
        super(spdxId);

        if (isNullOrUndefined(licensePath) || !fs.existsSync(licensePath)) {
            throw Error("licensePath should not be null/undefined and the pointing file should exist.");
        }

        this.licensePath = licensePath;
    }

    public getLicenseText(): string {
        return fs.readFileSync(this.licensePath, { encoding: "utf8" });
    }
}

class ReadmeLicense extends FileLicense {
    public getLicenseText(): string {
        const readmeText = super.getLicenseText();
        const licenseIdentifier = "## License";

        let licenseIndex = readmeText.indexOf(licenseIdentifier);

        if (licenseIndex < 0) {
            return null;
        } else {
            licenseIndex += licenseIdentifier.length;
        }

        const licenseEndIndex = readmeText.indexOf("#", licenseIndex);
        const nonCharRegex = /\w/g;

        for (let index = licenseIndex; index < readmeText.length; index++) {
            if (nonCharRegex.test(readmeText[index])) {
                licenseIndex = index;
                break;
            }
        }

        return readmeText.substring(licenseIndex, licenseEndIndex < 0 ? undefined : licenseEndIndex);
    }
}

const packagejson: INpmJson = require("./package.json");
const buildInfos: IBuildInfos = require("./buildInfos.json");

// buildInfos auto-initializiation
gutil.log("Starting", "buildInfos auto-initializiation", "...");

if (buildInfos.buildNumber === "*") {
    gutil.log("Read", "BUILD_BUILDNUMBER", "=", process.env["BUILD_BUILDNUMBER"]);
    gutil.log("Read", "packagejson.version", "=", packagejson.version)
    buildInfos.buildNumber = process.env["BUILD_BUILDNUMBER"] || packagejson.version;
    gutil.log("Initialized", "buildInfos.buildNumber:", "=", buildInfos.buildNumber);
}

if (buildInfos.paths.appDir === "*") {
    buildInfos.paths.appDir = path.join(buildInfos.paths.buildDir, "app");
    gutil.log("Initialized", "buildInfos.paths.appDir", "=", buildInfos.paths.appDir);
}

if (buildInfos.paths.sfxDir === "*") {
    buildInfos.paths.sfxDir = path.join(buildInfos.paths.appDir, "sfx");
    gutil.log("Initialized", "buildInfos.paths.sfxDir", "=", buildInfos.paths.sfxDir);
}

gutil.log("Finished", "buildInfos auto-initializiation", ".");

/* Utility functions */
function logExec(cmd: string, pifyResults: any): void {
    const [error, stdout, stderr] = pifyResults;

    gutil.log("Executed:", cmd);

    if (isString(stdout) && stdout.trim() !== "") {
        gutil.log(stdout);
    }

    if (isString(stderr) && stderr.trim() !== "") {
        gutil.log(stderr);
    }
}

function appdirExec(cmd: string): any {
    return exec(path.resolve(buildInfos.paths.appDir), cmd);
}

function exec(cwd: string, cmd: string): any {
    return pified_exec(cmd, { cwd: cwd })
        .then((pifyResults) => logExec(cmd, pifyResults));
}

function normalizeGlob(pattern: string, basePath: string): string {
    let finalPattern = pattern;

    if (pattern[0] === "!") {
        finalPattern = pattern.slice(1);
    }

    finalPattern = path.relative(basePath, path.resolve(finalPattern));

    if (pattern[0] === "!") {
        finalPattern = "!" + finalPattern;
    }

    return finalPattern;
}

function formGlobs(globs?: string | Array<string>): Array<string> {
    const outputGlobs: Array<string> = [];
    const basePath = path.resolve(".");
    const patterns: Array<string> = [
        String.format("!{}/**/*", buildInfos.paths.publishDir),
        String.format("!{}/**/*", buildInfos.paths.buildDir),
        String.format("!{}/**/*", "node_modules"),
        "!**/tsconfig.json",
        "!**/jsconfig.json",
        "!**/tslint.json",
        "!./buildInfos.json",
        "!**/*.md"
    ];

    if (isString(globs)) {
        outputGlobs.push(normalizeGlob(globs, basePath));
    }
    else if (Array.isArray(globs)) {
        globs.forEach((glob) => outputGlobs.push(normalizeGlob(glob, basePath)));
    }
    else if (!isNullOrUndefined(globs)) {
        throw "Unsupported globs: " + typeof globs;
    }

    patterns.forEach((pattern) => outputGlobs.push(normalizeGlob(pattern, basePath)));

    return outputGlobs;
}

function ensureDirExists(dirname: string): void {
    dirname = path.resolve(dirname);

    let dirs: Array<string> = [];

    while (!fs.existsSync(dirname)) {
        dirs.push(dirname);
        dirname = path.dirname(dirname);
    }

    while (dirs.length > 0) {
        fs.mkdirSync(dirs.pop());
    }
}

function generateVersionInfo(platform: Platform, getPackageInfo: (baseUrl: string, arch: Architecture) => string): void {
    if (!isFunction(getPackageInfo)) {
        throw new Error("getPackageInfo must be supplied.");
    }

    if (!isObject(buildInfos.updateInfos) || !isString(buildInfos.updateInfos.baseUrl)) {
        throw new Error("buildInfos.updateInfos.baseUrl must be specified.");
    }

    let channel: string = "public";
    let prerelease = semver.prerelease(buildInfos.buildNumber);

    if (Array.isArray(prerelease) && prerelease.length > 0) {
        channel = prerelease[0];
    }

    let versionInfo: IVersionInfo = {
        version: buildInfos.buildNumber
    };

    let baseUrl = String.format("{}/{}/{}", buildInfos.updateInfos.baseUrl, channel, platform);
    let buildPackageInfo = null;

    if (isObject(buildInfos.updateInfos.packageInfos)) {
        buildPackageInfo = buildInfos.updateInfos.packageInfos[platform];
    } else if (!isNullOrUndefined(buildInfos.updateInfos.packageInfos)) {
        throw new Error("Invalid value for parameter: buildInfos.updateInfos.packageInfos");
    }

    if (isString(buildPackageInfo)) {
        versionInfo[platform] = buildPackageInfo;
    } else if (isNullOrUndefined(buildPackageInfo) || isObject(buildPackageInfo)) {
        versionInfo[platform] = {};

        for (let arch of buildInfos.targets[platform].archs) {
            if (isNullOrUndefined(buildPackageInfo) || isNullOrUndefined(buildPackageInfo[arch])) {
                versionInfo[platform][arch] = getPackageInfo(baseUrl, arch);
            } else if (isString(buildPackageInfo[arch])) {
                versionInfo[platform][arch] = String.format(buildPackageInfo[arch], baseUrl, buildInfos.buildNumber, arch);
            } else {
                throw new Error(String.format("Invalid value for parameter: buildInfos.updateInfos.packageInfos.{}.{}", platform, arch));
            }
        }
    } else {
        throw new Error(String.format("Invalid value for parameter: buildInfos.updateInfos.packageInfos.{}", platform));
    }

    let versionInfoPath = path.resolve(path.join(buildInfos.paths.publishDir, String.format("version.{}.json", platform)));

    ensureDirExists(path.dirname(versionInfoPath));
    fs.writeFileSync(versionInfoPath, JSON.stringify(versionInfo, null, '\t'));
}

function convertToPackagerArch(arch: Architecture): string {
    switch (arch) {
        case Architecture.X86:
            return "ia32";

        case Architecture.X64:
            return "x64";

        default:
            throw "unsupported architecture: " + arch;
    };
}

function toPackagerArch(archs: Array<Architecture>): Array<string> {
    if (!Array.isArray(archs)) {
        throw "archs has to be an array.";
    }

    let convertedArchs: Array<string> = [];

    archs.forEach((arch) => convertedArchs.push(convertToPackagerArch(arch)));

    return convertedArchs;
}

function toPackagerPlatform(platform: Platform): string {
    switch (platform) {
        case Platform.Linux:
            return "linux";

        case Platform.Windows:
            return "win32";

        case Platform.MacOs:
            return "darwin";

        default:
            throw "unsupported platform: " + platform;
    };
}

function generatePackage(platform: Platform): any {
    let packConfig = {
        dir: buildInfos.paths.appDir,
        appCopyright: buildInfos.copyright,
        arch: <any>toPackagerArch(buildInfos.targets[platform].archs),
        asar: false,
        icon: path.join(buildInfos.paths.appDir, "icons/icon"),
        name: platform === Platform.MacOs ? buildInfos.productName : buildInfos.targetExecutableName,
        out: buildInfos.paths.buildDir,
        overwrite: true,
        platform: toPackagerPlatform(platform),
        appBundleId: buildInfos.appId,
        appCategoryType: buildInfos.appCategory
    };

    return packager(packConfig);
}

function getLicense(dep: IPackageJson): string {
    if (isString(dep.license)) {
        return dep.license;
    }

    const license = buildInfos.licensing.packageLicenses[dep.name];

    if (!isString(license)) {
        throw Error("Cannot determine the license of dep: " + dep.name);
    }

    return license;
}

function generateDep(depName: string, depsDir: string, packageJsonName: string): ILicensingDependency {
    const licenseFileNamePattern = /.*LICENSE.*/gi;
    const readmeFileNamePattern = /README.md/gi;
    const depDir: string = path.resolve(path.join(depsDir, depName));

    if (!fs.existsSync(depDir)) {
        throw new Error(String.format('Cannot find dependency "{}".'));
    }

    const depJson: IPackageJson = require(path.join(depDir, packageJsonName));
    let depLicense: ILicense = null;
    let readmeFileName: string = null;

    for (const fileName of fs.readdirSync(depDir)) {
        if (licenseFileNamePattern.test(fileName)) {
            depLicense = new FileLicense(getLicense(depJson), path.join(depDir, fileName));
            break;
        }

        if (readmeFileNamePattern.test(fileName)) {
            readmeFileName = fileName;
        }
    }

    if (depLicense === null && fs.existsSync(path.join(depDir, readmeFileName))) {
        depLicense = new ReadmeLicense(getLicense(depJson), path.join(depDir, readmeFileName));
    }

    if (isNullOrUndefined(depLicense)) {
        throw new Error(String.format('Cannot find license file for dependency, "{}".', depName));
    }

    return {
        name: depJson.name,
        version: depJson.version,
        homepage: depJson.homepage,
        license: depLicense
    };
}

function generateLicensingDeps(depType: "dev" | "prod", packageFormat: "npm" | "bower", depsDir: string, deps: IDictionary<string> | Array<string>): Array<ILicensingDependency> {
    if (isNullOrUndefined(deps)) {
        return [];
    }

    if (!fs.existsSync(depsDir)) {
        throw new Error(String.format('depsDir "{}" does not exist.', depsDir));
    }

    let depNames: Array<string>;

    if (Array.isArray(deps)) {
        depNames = deps;
    } else if (isObject(deps)) {
        depNames = Object.keys(deps);
    } else {
        throw new Error("unknow type of deps: " + typeof deps);
    }

    let licensingDeps: Array<ILicensingDependency> = [];
    let packageJsonName: string;

    switch (packageFormat) {
        case "bower":
            packageJsonName = ".bower.json";
            break;

        case "npm":
        default:
            packageJsonName = "package.json";
            break;
    }

    let hasErrors: boolean = false;

    depNames.forEach((depName) => {
        try {
            const dep = generateDep(depName, depsDir, packageJsonName);

            dep.depType = depType;
            licensingDeps.push(dep);
        } catch (error) {
            gutil.log("Failed to generate licensing dep for package:", depName, "Error:", error);
            hasErrors = true;
        }
    });

    if (hasErrors) {
        throw new Error("There are errors when resolving licensing dependencies.");
    }

    return licensingDeps;
}

function generateThirdPartyNotice(deps: Array<ILicensingDependency>, noticeFilePath: string): void {
    if (!Array.isArray(deps)) {
        throw new Error("deps must be a valid array of ILicensingDependency.");
    }

    if (!isString(noticeFilePath)) {
        throw new Error("noticeFilePath must be a valid string.");
    }

    noticeFilePath = path.resolve(noticeFilePath);

    if (fs.existsSync(noticeFilePath)) {
        fs.unlinkSync(noticeFilePath);
    }

    const noticeFd: number = fs.openSync(path.join(buildInfos.paths.appDir, buildInfos.licensing.thirdPartyNoticesFileName), "w");

    try {
        gutil.log("Generating third party notices files:", buildInfos.licensing.thirdPartyNoticesFileName, "...");
        fs.appendFileSync(noticeFd, "THIRD-PARTY SOFTWARE NOTICES AND INFORMATION\r\n");
        fs.appendFileSync(noticeFd, "Do Not Translate or Localize\r\n");
        fs.appendFileSync(noticeFd, "\r\n");
        fs.appendFileSync(noticeFd, "This project incorporates components from the projects listed below. The original copyright notices and the licenses under which Microsoft received such components are set forth below. Microsoft reserves all rights not expressly granted herein, whether by implication, estoppel or otherwise.\r\n");
        fs.appendFileSync(noticeFd, "\r\n");

        deps.forEach((dep, depIndex) => {
            fs.appendFileSync(noticeFd, String.format("{}.\t{} ({})\r\n", depIndex + 1, dep.name, dep.homepage));
        });

        for (const dep of deps) {
            fs.appendFileSync(noticeFd, "\r\n");
            fs.appendFileSync(noticeFd, String.format("{} NOTICES AND INFORMATION BEGIN HERE\r\n", dep.name));
            fs.appendFileSync(noticeFd, "=========================================\r\n");
            fs.appendFileSync(noticeFd, dep.license.getLicenseText() || String.format("{} License: {}", dep.license.spdxId, dep.homepage));
            fs.appendFileSync(noticeFd, "\r\n");
            fs.appendFileSync(noticeFd, "=========================================\r\n");
            fs.appendFileSync(noticeFd, String.format("END OF {} NOTICES AND INFORMATION\r\n", dep.name));
        }
    } finally {
        fs.closeSync(noticeFd);
        gutil.log("Finished generation of the third party notices files:", buildInfos.licensing.thirdPartyNoticesFileName, ".");
    }
}

function getTypescriptsGlobs() {
    const tsconfig: { include: Array<string>, exclude: Array<string>, compilerOptions: any } = require("./tsconfig.json");
    const globs = new Array<string>();

    // Include
    if (Array.isArray(tsconfig.include)) {
        globs.push(...tsconfig.include);
    } else if (!isNullOrUndefined(tsconfig.include)) {
        throw new Error("tsconfig.include must be an array!");
    }

    // Exclude
    if (Array.isArray(tsconfig.exclude)) {
        tsconfig.exclude.forEach((pattern) => globs.push("!" + pattern));
    } else if (!isNullOrUndefined(tsconfig.include)) {
        throw new Error("tsconfig.exclude must be an array!");
    }

    return formGlobs(globs);
}

/* Build tasks */

gulp.task("Build:tslint",
    () => gulp.src(getTypescriptsGlobs())
        .pipe(gtslint({ program: tslint.Linter.createProgram("./tsconfig.json") }))
        .pipe(gtslint.report({ summarizeFailureOutput: true })));

gulp.task("Build:ts", ["Build:tslint"],
    () => {
        const tsconfig: { include: Array<string>, exclude: Array<string>, compilerOptions: any } = require("./tsconfig.json");
        const compilterOptionsParseResult = ts.convertCompilerOptionsFromJson(tsconfig.compilerOptions, undefined);

        if (Array.isArray(compilterOptionsParseResult.errors) && compilterOptionsParseResult.errors.length > 0) {
            compilterOptionsParseResult.errors.forEach((error) => tsc.logDiagnostic(error));
            throw new Error("Failed to load typescript compiler options.");
        }

        compilterOptionsParseResult.options.outDir = buildInfos.paths.appDir;

        if (process.argv.indexOf("--production") >= 0) {
            compilterOptionsParseResult.options.sourceMap = false;
        }

        tsc.compile(
            compilterOptionsParseResult.options,
            globby.sync(getTypescriptsGlobs(), { dot: true }));
    });

gulp.task("Build:html",
    () => gulp.src(formGlobs("**/*.html"))
        .pipe(gulp.dest(buildInfos.paths.appDir)));

gulp.task("Build:img",
    () => gulp.src(formGlobs(["icons/**/*.*"]))
        .pipe(gulp.dest(path.join(buildInfos.paths.appDir, "icons"))));

gulp.task("Build:json",
    () => gulp.src(formGlobs(["**/*.json"]))
        .pipe(gulp.dest(buildInfos.paths.appDir)));

gulp.task("Build:node_modules", ["Build:json"],
    () => appdirExec("npm install --production"));

gulp.task("Build:sfx",
    () => gulp.src(["../Sfx/wwwroot/**/*.*"])
        .pipe(gulp.dest(buildInfos.paths.sfxDir)));

gulp.task("Build:licenses",
    () => gulp.src(formGlobs(["LICENSE"]))
        .pipe(gulp.dest(buildInfos.paths.appDir)));

gulp.task("Build:All", ["Build:sfx", "Build:ts", "Build:html", "Build:node_modules", "Build:json", "Build:img", "Build:licenses"]);

/* Pack tasks */
gulp.task("Pack:update-version",
    () => appdirExec(String.format("npm version {} --allow-same-version", buildInfos.buildNumber)));

gulp.task("Pack:licensing",
    () => {
        let msInternalDeps: Array<ILicensingDependency> = [];
        let prodDeps: Array<ILicensingDependency> = [];

        prodDeps = prodDeps.concat(generateLicensingDeps("prod", "npm", path.join(buildInfos.paths.appDir, "node_modules"), packagejson.dependencies));
        prodDeps = prodDeps.concat(generateLicensingDeps("prod", "npm", path.join(buildInfos.paths.appDir, "node_modules"), packagejson.optionalDependencies));

        if (fs.existsSync("../Sfx/package.json")) {
            let sfxPackageJson: INpmJson = require("../Sfx/package.json");

            prodDeps = prodDeps.concat(generateLicensingDeps("prod", "npm", "../Sfx/node_modules", sfxPackageJson.dependencies));
            prodDeps = prodDeps.concat(generateLicensingDeps("prod", "npm", "../Sfx/node_modules", sfxPackageJson.optionalDependencies));
        }

        if (fs.existsSync("../Sfx/bower_components")) {
            prodDeps = prodDeps.concat(generateLicensingDeps("prod", "bower", "../Sfx/bower_components", fs.readdirSync("../Sfx/bower_components", { encoding: "utf8" })));
        }

        msInternalDeps = msInternalDeps.concat(generateLicensingDeps("dev", "npm", "./node_modules", packagejson.devDependencies));

        generateThirdPartyNotice(prodDeps, path.join(buildInfos.paths.appDir, buildInfos.licensing.thirdPartyNoticesFileName));
    });

gulp.task("Pack:prepare",
    (callback) => runSequence(
        "Build:All",
        ["Pack:update-version", "Pack:licensing"],
        callback));

gulp.task("Pack:windows", ["Pack:prepare"],
    () => generatePackage(Platform.Windows));

gulp.task("Pack:linux", ["Pack:prepare"],
    () => generatePackage(Platform.Linux));

gulp.task("Pack:darwin", ["Pack:prepare"],
    () => generatePackage(Platform.MacOs));

/* Tasks for Windows */
gulp.task("Publish:versioninfo-windows",
    () => generateVersionInfo(
        Platform.Windows,
        (baseUrl, arch) => String.format("{}/setup-{}.{}.msi", baseUrl, buildInfos.buildNumber, arch)));

gulp.task("Publish:copy-msi.wxs",
    () => gulp.src(formGlobs(".build/msi.wxs")).pipe(gulp.dest(buildInfos.paths.buildDir)));

gulp.task("Publish:update-wix-version", ["Publish:copy-msi.wxs"],
    () => fs.writeFileSync(
        "./build/msi.wxs",
        fs.readFileSync("./build/msi.wxs", { encoding: "utf8" })
            .replace("$MSIVERSION$", [semver.major(buildInfos.buildNumber), semver.minor(buildInfos.buildNumber), semver.patch(buildInfos.buildNumber)].join(".")),
        { encoding: "utf8" }));

gulp.task("Publish:msi", ["Publish:update-wix-version"],
    (gcallback) => {
        let packDirName = String.format("{}-{}-{}", buildInfos.targetExecutableName, toPackagerPlatform(Platform.Windows), convertToPackagerArch(Architecture.X86));
        let packDirPath = path.resolve(path.join(buildInfos.paths.buildDir, packDirName));
        let publishDir = path.join(buildInfos.paths.publishDir, Platform.Windows);
        let filesWixPath = path.resolve(path.join(buildInfos.paths.buildDir, "files.msi.wxs"));
        let wxsobjDir = path.resolve(path.join(buildInfos.paths.buildDir, "wxsobj"));
        let heatPath = path.resolve("./.vendor/wix/heat.exe");
        let candlePath = path.resolve("./.vendor/wix/candle.exe");
        let lightPath = path.resolve("./.vendor/wix/light.exe");
        let heatCmd = String.format("\"{}\" dir \"{}\" -ag -srd -cg MainComponentsGroup -dr INSTALLFOLDER -o \"{}\"", heatPath, packDirPath, filesWixPath);
        let candleCmd = String.format("\"{}\" -arch x86 -out \"{}\\\\\" \"{}\" \"{}\"", candlePath, wxsobjDir, path.resolve("./build/msi.wxs"), filesWixPath);
        let lightCmd =
            String.format(
                "\"{}\" -b \"{}\" -spdb -out \"{}\" \"{}\" \"{}\"",
                lightPath,
                packDirPath,
                path.resolve(path.join(publishDir, buildInfos.buildNumber ? String.format("setup-{}.x86.msi", buildInfos.buildNumber) : "setup.x86.msi")),
                path.join(wxsobjDir, "msi.wixobj"), path.join(wxsobjDir, "files.msi.wixobj"));

        return appdirExec(heatCmd)
            .then(() => appdirExec(candleCmd)
                .then(() => appdirExec(lightCmd)));
    });

gulp.task("Publish:win32",
    (callback) => runSequence(
        "Pack:windows",
        ["Publish:versioninfo-windows", "Publish:msi"],
        callback));

/* Tasks for Debian-based linux */
function toDebArch(arch: Architecture): string {
    switch (arch) {
        case Architecture.X86:
            return "i386";

        case Architecture.X64:
            return "amd64";

        default:
            throw "unsupported architecture: " + arch;
    };
}

function getDebOptions(arch: Architecture): object {
    let packDirName = String.format("{}-{}-{}", buildInfos.targetExecutableName, toPackagerPlatform(Platform.Linux), convertToPackagerArch(arch));
    let packDirPath = path.resolve(path.join(buildInfos.paths.buildDir, packDirName));

    return {
        src: packDirPath,
        dest: path.join(buildInfos.paths.publishDir, Platform.Linux),
        arch: toDebArch(arch),
        name: buildInfos.targetExecutableName,
        productName: buildInfos.productName,
        genericName: buildInfos.productName,
        version: buildInfos.buildNumber,
        revision: "0",
        section: "utils",
        bin: buildInfos.targetExecutableName,
        icon: {
            '16x16': 'icons/icon16x16.png',
            '32x32': 'icons/icon32x32.png',
            '48x48': 'icons/icon48x48.png',
            '52x52': 'icons/icon52x52.png',
            '64x64': 'icons/icon64x64.png',
            '96x96': 'icons/icon96x96.png',
            '128x128': 'icons/icon128x128.png',
            '192x192': 'icons/icon192x192.png',
            '256x256': 'icons/icon256x256.png',
            '512x512': 'icons/icon512x512.png',
            '1024x1024': 'icons/icon1024x1024.png'
        },
        categories: ["Utility", "Development"]
    };
}

gulp.task("Publish:versioninfo-linux",
    () => generateVersionInfo(
        Platform.Linux,
        (baseUrl, arch) => String.format("{}/{}_{}_{}.deb", baseUrl, buildInfos.targetExecutableName, buildInfos.buildNumber, toDebArch(arch))));

gulp.task("Publish:deb-x86",
    (callback) => {
        let debBuilder = require('electron-installer-debian');
        let debOptions = getDebOptions(Architecture.X86);

        debBuilder(debOptions, callback);
    });

gulp.task("Publish:deb-x64",
    (callback) => {
        let debBuilder = require('electron-installer-debian');
        let debOptions = getDebOptions(Architecture.X64);

        debBuilder(debOptions, callback);
    });

gulp.task("Publish:linux",
    (callback) => runSequence(
        "Pack:linux",
        ["Publish:versioninfo-linux", "Publish:deb-x86", "Publish:deb-x64"],
        callback));

/* Tasks for darwin (macOS) */
function getZipName(arch: Architecture): string {
    return String.format("{}-{}-{}.zip", buildInfos.targetExecutableName, buildInfos.buildNumber, arch);
}

gulp.task("Publish:versioninfo-darwin",
    () => generateVersionInfo(
        Platform.MacOs,
        (baseUrl, arch) => String.format("{}/{}", baseUrl, getZipName(arch))));

gulp.task("Publish:zip-darwin-x64",
    (callback) => {
        if (buildInfos.targets[Platform.MacOs].archs.indexOf(Architecture.X64) < 0) {
            gutil.log("Skipping", "zip-darwin-64:", "No x64 architecture specified in buildinfos.");
            callback();
            return;
        }

        const macZipper = require('electron-installer-zip');
        const packDirName = String.format("{}-{}-{}", buildInfos.productName, toPackagerPlatform(Platform.MacOs), Architecture.X64);
        const appDirName = String.format("{}.app", buildInfos.productName);

        macZipper(
            {
                dir: path.resolve(path.join(buildInfos.paths.buildDir, packDirName, appDirName)),
                out: path.resolve(path.join(buildInfos.paths.publishDir, Platform.MacOs, getZipName(Architecture.X64)))
            },
            (err, res) => callback(err))
    });

gulp.task("Publish:darwin",
    (callback) => runSequence(
        "Pack:darwin",
        ["Publish:versioninfo-darwin", "Publish:zip-darwin-x64"],
        callback));