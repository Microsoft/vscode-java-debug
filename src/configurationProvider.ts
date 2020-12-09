// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.
import * as fs from "fs";
import * as _ from "lodash";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { instrumentOperation, sendInfo } from "vscode-extension-telemetry-wrapper";
import * as anchor from "./anchor";
import { buildWorkspace } from "./build";
import { populateStepFilters, substituteFilterVariables } from "./classFilter";
import * as commands from "./commands";
import * as lsPlugin from "./languageServerPlugin";
import { addMoreHelpfulVMArgs, detectLaunchCommandStyle, validateRuntime } from "./launchCommand";
import { logger, Type } from "./logger";
import { mainClassPicker } from "./mainClassPicker";
import { resolveJavaProcess } from "./processPicker";
import { IProgressReporter } from "./progressAPI";
import { progressReporterManager } from "./progressImpl";
import * as utility from "./utility";

const platformNameMappings: {[key: string]: string} = {
    win32: "windows",
    linux: "linux",
    darwin: "osx",
};
const platformName = platformNameMappings[process.platform];

export class JavaDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    private isUserSettingsDirty: boolean = true;
    constructor() {
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("java.debug")) {
                if (vscode.debug.activeDebugSession) {
                    this.isUserSettingsDirty = false;
                    return updateDebugSettings(event);
                } else {
                    this.isUserSettingsDirty = true;
                }
            }
            return undefined;
        });
    }

    // Returns an initial debug configurations based on contextual information.
    public provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined, token?: vscode.CancellationToken):
        vscode.ProviderResult<vscode.DebugConfiguration[]> {
        const provideDebugConfigurationsHandler = instrumentOperation("provideDebugConfigurations", (_operationId: string) => {
            return <Thenable<vscode.DebugConfiguration[]>>this.provideDebugConfigurationsAsync(folder, token);
        });
        return provideDebugConfigurationsHandler();
    }

    // Try to add all missing attributes to the debug configuration being launched.
    public resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined,
                                     config: vscode.DebugConfiguration, _token?: vscode.CancellationToken):
        vscode.ProviderResult<vscode.DebugConfiguration> {
        // If no debug configuration is provided, then generate one in memory.
        if (this.isEmptyConfig(config)) {
            config.type = "java";
            config.name = "Java Debug";
            config.request = "launch";
        }

        return config;
    }

    // Try to add all missing attributes to the debug configuration being launched.
    public resolveDebugConfigurationWithSubstitutedVariables(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {
        const resolveDebugConfigurationHandler = instrumentOperation("resolveDebugConfiguration", (_operationId: string) => {
            try {
                // See https://github.com/microsoft/vscode-java-debug/issues/778
                // Merge the platform specific properties to the global config to simplify the subsequent resolving logic.
                this.mergePlatformProperties(config, folder);
                return this.resolveAndValidateDebugConfiguration(folder, config, token);
            } catch (ex) {
                utility.showErrorMessage({
                    type: Type.EXCEPTION,
                    message: String((ex && ex.message) || ex),
                });
                return undefined;
            }
        });
        return resolveDebugConfigurationHandler();
    }

    private provideDebugConfigurationsAsync(folder: vscode.WorkspaceFolder | undefined, token?: vscode.CancellationToken) {
        return new Promise(async (resolve, _reject) => {
            const progressReporter = progressReporterManager.create("Create launch.json", true);
            progressReporter.observe(token);
            const defaultLaunchConfig = {
                type: "java",
                name: "Debug (Launch) - Current File",
                request: "launch",
                // tslint:disable-next-line
                mainClass: "${file}",
            };
            try {
                const isOnStandardMode = await utility.waitForStandardMode(progressReporter);
                if (!isOnStandardMode) {
                    resolve([defaultLaunchConfig]);
                    return ;
                }

                if (progressReporter.isCancelled()) {
                    resolve([defaultLaunchConfig]);
                    return;
                }
                progressReporter.report("Resolve Java Configs", "Auto generating Java configuration...");
                const mainClasses = await lsPlugin.resolveMainClass(folder ? folder.uri : undefined);
                const cache = {};
                const launchConfigs = mainClasses.map((item) => {
                    return {
                        ...defaultLaunchConfig,
                        name: this.constructLaunchConfigName(item.mainClass, cache, item.projectName),
                        mainClass: item.mainClass,
                        projectName: item.projectName,
                    };
                });
                if (progressReporter.isCancelled()) {
                    resolve([defaultLaunchConfig]);
                    return;
                }
                resolve([defaultLaunchConfig, ...launchConfigs]);
            } catch (ex) {
                if (ex instanceof utility.JavaExtensionNotEnabledError) {
                    utility.guideToInstallJavaExtension();
                } else {
                    // tslint:disable-next-line
                    console.error(ex);
                }

                resolve([defaultLaunchConfig]);
            } finally {
                progressReporter.cancel();
            }
        });
    }

    private mergePlatformProperties(config: vscode.DebugConfiguration, _folder?: vscode.WorkspaceFolder) {
        if (config && platformName && config[platformName]) {
            try {
                for (const key of Object.keys(config[platformName])) {
                    config[key] = config[platformName][key];
                }
                config[platformName] = undefined;
            } catch {
                // do nothing
            }
        }
    }

    private constructLaunchConfigName(mainClass: string, cache: {[key: string]: any}, projectName?: string) {
        const prefix = "Debug (Launch)-";
        let name = prefix + mainClass.substr(mainClass.lastIndexOf(".") + 1);
        if (projectName !== undefined) {
            name += `<${projectName}>`;
        }
        if (cache[name] === undefined) {
            cache[name] = 0;
            return name;
        } else {
            cache[name] += 1;
            return `${name}(${cache[name]})`;
        }
    }

    private async resolveAndValidateDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration,
                                                       token?: vscode.CancellationToken) {
        let progressReporter = progressReporterManager.get(config.__progressId);
        if (!progressReporter && config.__progressId) {
            return undefined;
        }
        progressReporter = progressReporter || progressReporterManager.create(config.noDebug ? "Run" : "Debug");
        progressReporter.observe(token);
        if (progressReporter.isCancelled()) {
            return undefined;
        }

        try {
            const isOnStandardMode = await utility.waitForStandardMode(progressReporter);
            if (!isOnStandardMode || progressReporter.isCancelled()) {
                return undefined;
            }

            if (this.isUserSettingsDirty) {
                this.isUserSettingsDirty = false;
                await updateDebugSettings();
            }

            // If no debug configuration is provided, then generate one in memory.
            if (this.isEmptyConfig(config)) {
                config.type = "java";
                config.name = "Java Debug";
                config.request = "launch";
            }

            if (config.request === "launch") {
                // If the user doesn't specify 'vmArgs' in launch.json, use the global setting to get the default vmArgs.
                if (config.vmArgs === undefined) {
                    const debugSettings: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("java.debug.settings");
                    config.vmArgs = debugSettings.vmArgs;
                }
                // If the user doesn't specify 'console' in launch.json, use the global setting to get the launch console.
                if (!config.console) {
                    const debugSettings: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("java.debug.settings");
                    config.console = debugSettings.console;
                }
                // If the console is integratedTerminal, don't auto switch the focus to DEBUG CONSOLE.
                if (config.console === "integratedTerminal" && !config.internalConsoleOptions) {
                    config.internalConsoleOptions = "neverOpen";
                }

                if (needsBuildWorkspace()) {
                    progressReporter.report("Compile", "Compiling Java workspace...");
                    const proceed = await buildWorkspace(progressReporter);
                    if (!proceed) {
                        return undefined;
                    }
                }

                if (progressReporter.isCancelled()) {
                    return undefined;
                }
                if (!config.mainClass) {
                    progressReporter.report("Resolve mainClass", "Resolving main class...");
                } else {
                    progressReporter.report("Resolve Configuration", "Resolving launch configuration...");
                }
                const mainClassOption = await this.resolveAndValidateMainClass(folder && folder.uri, config, progressReporter);
                if (!mainClassOption || !mainClassOption.mainClass) { // Exit silently if the user cancels the prompt fix by ESC.
                    // Exit the debug session.
                    return undefined;
                }

                progressReporter.report("Resolve Configuration", "Resolving launch configuration...");
                config.mainClass = mainClassOption.mainClass;
                config.projectName = mainClassOption.projectName;

                if (progressReporter.isCancelled()) {
                    return undefined;
                }
                if (_.isEmpty(config.classPaths) && _.isEmpty(config.modulePaths)) {
                    const result = <any[]>(await lsPlugin.resolveClasspath(config.mainClass, config.projectName));
                    config.modulePaths = result[0];
                    config.classPaths = result[1];
                }
                if (_.isEmpty(config.classPaths) && _.isEmpty(config.modulePaths)) {
                    throw new utility.UserError({
                        message: "Cannot resolve the modulepaths/classpaths automatically, please specify the value in the launch.json.",
                        type: Type.USAGEERROR,
                    });
                }

                config.javaExec = await lsPlugin.resolveJavaExecutable(config.mainClass, config.projectName);
                // Add the default launch options to the config.
                config.cwd = config.cwd || _.get(folder, "uri.fsPath");
                if (Array.isArray(config.args)) {
                    config.args = this.concatArgs(config.args);
                }

                if (Array.isArray(config.vmArgs)) {
                    config.vmArgs = this.concatArgs(config.vmArgs);
                }

                if (progressReporter.isCancelled()) {
                    return undefined;
                }
                // Populate the class filters to the debug configuration.
                await populateStepFilters(config);

                // Auto add '--enable-preview' vmArgs if the java project enables COMPILER_PB_ENABLE_PREVIEW_FEATURES flag.
                if (await lsPlugin.detectPreviewFlag(config.mainClass, config.projectName)) {
                    config.vmArgs = (config.vmArgs || "") + " --enable-preview";
                    validateRuntime(config);
                }

                // Add more helpful vmArgs.
                await addMoreHelpfulVMArgs(config);

                if (!config.shortenCommandLine || config.shortenCommandLine === "auto") {
                    config.shortenCommandLine = await detectLaunchCommandStyle(config);
                }

                if (process.platform === "win32" && config.console !== "internalConsole") {
                    config.launcherScript = utility.getLauncherScriptPath();
                }
            } else if (config.request === "attach") {
                if (config.hostName && config.port) {
                    config.processId = undefined;
                    // Continue if the hostName and port are configured.
                } else if (config.processId !== undefined) {
                    // tslint:disable-next-line
                    if (config.processId === "${command:PickJavaProcess}") {
                        return undefined;
                    }

                    const pid: number = Number(config.processId);
                    if (Number.isNaN(pid)) {
                        vscode.window.showErrorMessage(`The processId config '${config.processId}' is not a valid process id.`);
                        return undefined;
                    }

                    const javaProcess = await resolveJavaProcess(pid);
                    if (!javaProcess) {
                        vscode.window.showErrorMessage(`Attach to process: pid '${config.processId}' is not a debuggable Java process. `
                            + `Please make sure the process has turned on debug mode using vmArgs like `
                            + `'-agentlib:jdwp=transport=dt_socket,server=y,address=5005.'`);
                        return undefined;
                    }

                    config.processId = undefined;
                    config.hostName = javaProcess.hostName;
                    config.port = javaProcess.debugPort;
                } else {
                    throw new utility.UserError({
                        message: "Please specify the hostName/port directly, or provide the processId of the remote debuggee in the launch.json.",
                        type: Type.USAGEERROR,
                        anchor: anchor.ATTACH_CONFIG_ERROR,
                    });
                }

                // Populate the class filters to the debug configuration.
                await populateStepFilters(config);
            } else {
                throw new utility.UserError({
                    message: `Request type "${config.request}" is not supported. Only "launch" and "attach" are supported.`,
                    type: Type.USAGEERROR,
                    anchor: anchor.REQUEST_TYPE_NOT_SUPPORTED,
                });
            }

            if (token?.isCancellationRequested || progressReporter.isCancelled()) {
                return undefined;
            }

            delete config.__progressId;
            return config;
        } catch (ex) {
            if (ex instanceof utility.JavaExtensionNotEnabledError) {
                utility.guideToInstallJavaExtension();
                return undefined;
            }
            if (ex instanceof utility.UserError) {
                utility.showErrorMessageWithTroubleshooting(ex.context);
                return undefined;
            }

            utility.showErrorMessageWithTroubleshooting(utility.convertErrorToMessage(ex));
            return undefined;
        } finally {
            progressReporter.cancel();
        }
    }

    /**
     * Converts an array of arguments to a string as the args and vmArgs.
     */
    private concatArgs(args: any[]): string {
        return _.join(_.map(args, (arg: any): string => {
            const str = String(arg);
            // if it has quotes or spaces, use double quotes to wrap it
            if (/["\s]/.test(str)) {
                return "\"" + str.replace(/(["\\])/g, "\\$1") + "\"";
            }
            return str;

            // if it has only single quotes
        }), " ");
    }

    /**
     * When VS Code cannot find any available DebugConfiguration, it passes a { noDebug?: boolean } to resolve.
     * This function judges whether a DebugConfiguration is empty by filtering out the field "noDebug".
     */
    private isEmptyConfig(config: vscode.DebugConfiguration): boolean {
        return Object.keys(config).filter((key: string) => key !== "noDebug").length === 0;
    }

    private async resolveAndValidateMainClass(folder: vscode.Uri | undefined, config: vscode.DebugConfiguration,
                                              progressReporter: IProgressReporter): Promise<lsPlugin.IMainClassOption | undefined> {
        if (!config.mainClass || this.isFile(config.mainClass)) {
            const currentFile = config.mainClass ||  _.get(vscode.window.activeTextEditor, "document.uri.fsPath");
            if (currentFile) {
                const mainEntries = await lsPlugin.resolveMainMethod(vscode.Uri.file(currentFile));
                if (mainEntries.length) {
                    progressReporter.report("Select mainClass", "Selecting the main class to run...");
                    return mainClassPicker.showQuickPick(mainEntries, "Please select a main class you want to run.");
                }
            }

            const hintMessage = currentFile ?
                `The file '${path.basename(currentFile)}' is not executable, please select a main class you want to run.` :
                "Please select a main class you want to run.";
            return this.promptMainClass(folder, progressReporter, hintMessage);
        }

        const containsExternalClasspaths = !_.isEmpty(config.classPaths) || !_.isEmpty(config.modulePaths);
        const validationResponse = await lsPlugin.validateLaunchConfig(config.mainClass, config.projectName, containsExternalClasspaths, folder);
        if (!validationResponse.mainClass.isValid || !validationResponse.projectName.isValid) {
            return this.fixMainClass(folder, config, validationResponse, progressReporter);
        }

        return {
            mainClass: config.mainClass,
            projectName: config.projectName,
        };
    }

    private isFile(filePath: string): boolean {
        try {
            return fs.lstatSync(filePath).isFile();
        } catch (error) {
            // do nothing
            return false;
        }
    }

    private async fixMainClass(folder: vscode.Uri | undefined, config: vscode.DebugConfiguration,
                               validationResponse: lsPlugin.ILaunchValidationResponse, progressReporter: IProgressReporter):
                               Promise<lsPlugin.IMainClassOption | undefined> {
        const errors: string[] = [];
        if (!validationResponse.mainClass.isValid) {
            errors.push(String(validationResponse.mainClass.message));
        }

        if (!validationResponse.projectName.isValid) {
            errors.push(String(validationResponse.projectName.message));
        }

        if (validationResponse.proposals && validationResponse.proposals.length) {
            progressReporter.report("Confirm Config Error", "Config error, please select the next action...");
            const answer = await utility.showErrorMessageWithTroubleshooting({
                message: errors.join(os.EOL),
                type: Type.USAGEERROR,
                anchor: anchor.FAILED_TO_RESOLVE_CLASSPATH,
            }, "Fix");
            if (answer === "Fix") {
                progressReporter.report("Select mainClass", "Select the main class to run...");
                const selectedFix = await mainClassPicker.showQuickPick(validationResponse.proposals,
                    "Please select main class<project name>.", false);
                if (selectedFix) {
                    sendInfo("", {
                        fix: "yes",
                        fixMessage: errors.join(os.EOL),
                    });

                    // Deprecated
                    logger.log(Type.USAGEDATA, {
                        fix: "yes",
                        fixMessage: errors.join(os.EOL),
                    });
                    await this.persistMainClassOption(folder, config, selectedFix);
                }

                return selectedFix;
            }
            // return undefined if the user clicks "Learn More".
            return undefined;
        }

        throw new utility.UserError({
            message: errors.join(os.EOL),
            type: Type.USAGEERROR,
            anchor: anchor.FAILED_TO_RESOLVE_CLASSPATH,
        });
    }

    private async persistMainClassOption(folder: vscode.Uri | undefined, oldConfig: vscode.DebugConfiguration, change: lsPlugin.IMainClassOption):
        Promise<void> {
        const newConfig: vscode.DebugConfiguration = _.cloneDeep(oldConfig);
        newConfig.mainClass = change.mainClass;
        newConfig.projectName = change.projectName;

        return this.persistLaunchConfig(folder, oldConfig, newConfig);
    }

    private async persistLaunchConfig(folder: vscode.Uri | undefined, oldConfig: vscode.DebugConfiguration, newConfig: vscode.DebugConfiguration):
        Promise<void> {
        const launchConfigurations: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("launch", folder);
        const rawConfigs: vscode.DebugConfiguration[] = launchConfigurations.configurations;
        const targetIndex: number = _.findIndex(rawConfigs, (config) => _.isEqual(config, oldConfig));
        if (targetIndex >= 0) {
            rawConfigs[targetIndex] = newConfig;
            await launchConfigurations.update("configurations", rawConfigs);
        }
    }

    private async promptMainClass(folder: vscode.Uri | undefined, progressReporter: IProgressReporter, hintMessage?: string):
        Promise<lsPlugin.IMainClassOption | undefined> {
        const res = await lsPlugin.resolveMainClass(folder);
        if (res.length === 0) {
            const workspaceFolder = folder ? vscode.workspace.getWorkspaceFolder(folder) : undefined;
            throw new utility.UserError({
                message: `Cannot find a class with the main method${ workspaceFolder ? " in the folder '" + workspaceFolder.name + "'" : ""}.`,
                type: Type.USAGEERROR,
                anchor: anchor.CANNOT_FIND_MAIN_CLASS,
            });
        }

        progressReporter.report("Select mainClass", "Selecting the main class to run...");
        return mainClassPicker.showQuickPickWithRecentlyUsed(res, hintMessage || "Select main class<project name>");
    }
}

async function updateDebugSettings(event?: vscode.ConfigurationChangeEvent) {
    const debugSettingsRoot: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("java.debug");
    if (!debugSettingsRoot) {
        return;
    }
    const logLevel = convertLogLevel(debugSettingsRoot.logLevel || "");
    const javaHome = await utility.getJavaHome();
    if (debugSettingsRoot.settings && Object.keys(debugSettingsRoot.settings).length) {
        try {
            const stepFilters = {
                skipClasses: await substituteFilterVariables(debugSettingsRoot.settings.stepping.skipClasses),
                skipSynthetics: debugSettingsRoot.settings.skipSynthetics,
                skipStaticInitializers: debugSettingsRoot.settings.skipStaticInitializers,
                skipConstructors: debugSettingsRoot.settings.skipConstructors,
            };
            const exceptionFilters = {
                skipClasses: await substituteFilterVariables(debugSettingsRoot.settings.exceptionBreakpoint.skipClasses),
            };
            const settings = await commands.executeJavaLanguageServerCommand(commands.JAVA_UPDATE_DEBUG_SETTINGS, JSON.stringify(
                {
                    ...debugSettingsRoot.settings,
                    logLevel,
                    javaHome,
                    stepFilters,
                    exceptionFilters,
                    exceptionFiltersUpdated: event && event.affectsConfiguration("java.debug.settings.exceptionBreakpoint.skipClasses"),
                    limitOfVariablesPerJdwpRequest: Math.max(debugSettingsRoot.settings.jdwp.limitOfVariablesPerJdwpRequest, 1),
                    jdwpRequestTimeout: Math.max(debugSettingsRoot.settings.jdwp.requestTimeout, 100),
                }));
            if (logLevel === "FINE") {
                // tslint:disable-next-line:no-console
                console.log("settings:", settings);
            }
        } catch (err) {
            // log a warning message and continue, since update settings failure should not block debug session
            // tslint:disable-next-line:no-console
            console.log("Cannot update debug settings.", err);
        }
    }
}

function needsBuildWorkspace(): boolean {
    const debugSettingsRoot: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("java.debug.settings");
    return debugSettingsRoot ? debugSettingsRoot.forceBuildBeforeLaunch : true;
}

function convertLogLevel(commonLogLevel: string) {
    // convert common log level to java log level
    switch (commonLogLevel.toLowerCase()) {
        case "verbose":
            return "FINE";
        case "warn":
            return "WARNING";
        case "error":
            return "SEVERE";
        case "info":
            return "INFO";
        default:
            return "FINE";
    }
}
