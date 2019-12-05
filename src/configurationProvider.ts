// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.
import * as fs from "fs";
import * as _ from "lodash";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { instrumentOperation } from "vscode-extension-telemetry-wrapper";
import * as anchor from "./anchor";
import { buildWorkspace } from "./build";
import * as commands from "./commands";
import * as lsPlugin from "./languageServerPlugin";
import { detectLaunchCommandStyle } from "./launchCommand";
import { logger, Type } from "./logger";
import * as utility from "./utility";
import { VariableResolver } from "./variableResolver";

export class JavaDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    private isUserSettingsDirty: boolean = true;
    private debugHistory: MostRecentlyUsedHistory = new MostRecentlyUsedHistory();
    private resolver: VariableResolver;

    constructor() {
        this.resolver = new VariableResolver();
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (vscode.debug.activeDebugSession) {
                this.isUserSettingsDirty = false;
                return updateDebugSettings();
            } else {
                this.isUserSettingsDirty = true;
            }
        });
    }

    // Returns an initial debug configurations based on contextual information.
    public provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined, token?: vscode.CancellationToken):
        vscode.ProviderResult<vscode.DebugConfiguration[]> {
        const provideDebugConfigurationsHandler = instrumentOperation("provideDebugConfigurations", (operationId: string) => {
            return <Thenable<vscode.DebugConfiguration[]>>this.provideDebugConfigurationsAsync(folder);
        });
        return provideDebugConfigurationsHandler();
    }

    // Try to add all missing attributes to the debug configuration being launched.
    public resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken):
        vscode.ProviderResult<vscode.DebugConfiguration> {
        const resolveDebugConfigurationHandler = instrumentOperation("resolveDebugConfiguration", (operationId: string) => {
            try {
                this.resolveVariables(folder, config);
                return this.heuristicallyResolveDebugConfiguration(folder, config);
            } catch (ex) {
                utility.showErrorMessage({
                    message: String((ex && ex.message) || ex),
                });
                return undefined;
            }
        });
        return resolveDebugConfigurationHandler();
    }

    private provideDebugConfigurationsAsync(folder: vscode.WorkspaceFolder | undefined, token?: vscode.CancellationToken) {
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Window }, (p) => {
            return new Promise(async (resolve, reject) => {
                p.report({ message: "Auto generating configuration..." });
                const defaultLaunchConfig = {
                    type: "java",
                    name: "Debug (Launch) - Current File",
                    request: "launch",
                    // tslint:disable-next-line
                    mainClass: "${file}",
                };
                try {
                    const mainClasses = await lsPlugin.resolveMainClass(folder ? folder.uri : undefined);
                    let cache;
                    cache = {};
                    const launchConfigs = mainClasses.map((item) => {
                        return {
                            ...defaultLaunchConfig,
                            name: this.constructLaunchConfigName(item.mainClass, item.projectName, cache),
                            mainClass: item.mainClass,
                            projectName: item.projectName,
                        };
                    });
                    resolve([defaultLaunchConfig, ...launchConfigs]);
                } catch (ex) {
                    if (ex instanceof utility.JavaExtensionNotActivatedError) {
                        utility.guideToInstallJavaExtension();
                    }
                    p.report({ message: `failed to generate configuration. ${ex}` });
                    resolve(defaultLaunchConfig);
                }
            });
        });
    }

    private resolveVariables(folder: vscode.WorkspaceFolder, config: vscode.DebugConfiguration): void {
        // all the properties whose values are string or array of string
        const keys = ["mainClass", "args", "vmArgs", "modulePaths", "classPaths", "projectName",
            "env", "sourcePaths", "encoding", "cwd", "hostName", "javaHome"];
        if (!config) {
            return;
        }
        for (const key of keys) {
            if (config.hasOwnProperty(key)) {
                const value = config[key];
                if (_.isString(value)) {
                    config[key] = this.resolver.resolveString(folder ? folder.uri : undefined, value);
                } else if (_.isArray(value)) {
                    config[key] = _.map(value, (item) =>
                        _.isString(item) ? this.resolver.resolveString(folder ? folder.uri : undefined, item) : item);
                }
            }
        }
    }

    private constructLaunchConfigName(mainClass: string, projectName: string, cache: {}) {
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

    private async heuristicallyResolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration) {
        try {
            if (this.isUserSettingsDirty) {
                this.isUserSettingsDirty = false;
                await updateDebugSettings(config);
            }

            /**
             * If no launch.json exists in the current workspace folder
             * delegate to provideDebugConfigurations api to generate the initial launch.json configurations
             */
            if (this.isEmptyConfig(config) && folder) {
                // Follow the feature request https://github.com/Microsoft/vscode/issues/54213#issuecomment-420965778,
                // in order to generate launch.json, the resolveDebugConfiguration api must return null explicitly.
                return null;
            }

            // If it's the single file case that no workspace folder is opened, generate debug config in memory
            if (this.isEmptyConfig(config) && !folder) {
                config.type = "java";
                config.name = "Java Debug";
                config.request = "launch";
            }

            if (config.request === "launch") {
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
                    const proceed = await buildWorkspace();
                    if (!proceed) {
                        return undefined;
                    }
                }

                const mainClassOption = await this.resolveLaunchConfig(folder ? folder.uri : undefined, config);
                if (!mainClassOption || !mainClassOption.mainClass) { // Exit silently if the user cancels the prompt fix by ESC.
                    // Exit the debug session.
                    return;
                }

                config.mainClass = mainClassOption.mainClass;
                config.projectName = mainClassOption.projectName;

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
                if (!_.isEmpty(config.javaHome) && !fs.existsSync(config.javaHome)) {
                    config.javaHome = "";
                }

                // Add the default launch options to the config.
                config.cwd = config.cwd || _.get(folder, "uri.fsPath");
            } else if (config.request === "attach") {
                if (!config.hostName || !config.port) {
                    throw new utility.UserError({
                        message: "Please specify the host name and the port of the remote debuggee in the launch.json.",
                        type: Type.USAGEERROR,
                        anchor: anchor.ATTACH_CONFIG_ERROR,
                    });
                }
                // This doesn't make sense with an attached debugger
                if (!_.isEmpty(config.javaHome)) {
                    config.javaHome = "";
                }
            } else {
                throw new utility.UserError({
                    message: `Request type "${config.request}" is not supported. Only "launch" and "attach" are supported.`,
                    type: Type.USAGEERROR,
                    anchor: anchor.REQUEST_TYPE_NOT_SUPPORTED,
                });
            }

            if (Array.isArray(config.args)) {
                config.args = this.concatArgs(config.args);
            }

            if (Array.isArray(config.vmArgs)) {
                config.vmArgs = this.concatArgs(config.vmArgs);
            }

            // Auto add '--enable-preview' vmArgs if the java project enables COMPILER_PB_ENABLE_PREVIEW_FEATURES flag.
            if (await lsPlugin.detectPreviewFlag(config.mainClass, config.projectName)) {
                config.vmArgs = (config.vmArgs || "") + " --enable-preview";
            }

            if (config.request === "launch" && (!config.shortenCommandLine || config.shortenCommandLine === "auto")) {
                config.shortenCommandLine = await detectLaunchCommandStyle(config);
            }

            if (process.platform === "win32" && config.request === "launch" && config.console !== "internalConsole") {
                config.launcherScript = utility.getLauncherScriptPath();
            }

            const debugServerPort = await lsPlugin.startDebugSession();
            if (debugServerPort) {
                config.debugServer = debugServerPort;
                return config;
            } else {
                // Information for diagnostic:
                // tslint:disable-next-line:no-console
                console.log("Cannot find a port for debugging session");
                throw new Error("Failed to start debug server.");
            }
        } catch (ex) {
            if (ex instanceof utility.JavaExtensionNotActivatedError) {
                utility.guideToInstallJavaExtension();
                return undefined;
            }
            if (ex instanceof utility.UserError) {
                utility.showErrorMessageWithTroubleshooting(ex.context);
                return undefined;
            }

            const errorMessage = (ex && ex.message) || ex;
            utility.showErrorMessageWithTroubleshooting({
                message: String(errorMessage),
                type: Type.EXCEPTION,
                details: utility.formatErrorProperties(ex),
            });
            return undefined;
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

    private async resolveLaunchConfig(folder: vscode.Uri | undefined, config: vscode.DebugConfiguration): Promise<lsPlugin.IMainClassOption> {
        if (!config.mainClass || this.isFile(config.mainClass)) {
            const currentFile = config.mainClass ||  _.get(vscode.window.activeTextEditor, "document.uri.fsPath");
            if (currentFile) {
                const mainEntries = await lsPlugin.resolveMainMethod(vscode.Uri.file(currentFile));
                if (mainEntries.length === 1) {
                    return mainEntries[0];
                } else if (mainEntries.length > 1) {
                    return this.showMainClassQuickPick(this.formatMainClassOptions(mainEntries),
                        `Multiple main classes found in the file '${path.basename(currentFile)}', please select one first.`);
                }
            }

            const hintMessage = currentFile ?
                `No main class found in the file '${path.basename(currentFile)}', please select main class<project name> again.` :
                "Please select main class<project name>.";
            return this.promptMainClass(folder, hintMessage);
        }

        const containsExternalClasspaths = !_.isEmpty(config.classPaths) || !_.isEmpty(config.modulePaths);
        const validationResponse = await lsPlugin.validateLaunchConfig(folder, config.mainClass, config.projectName, containsExternalClasspaths);
        if (!validationResponse.mainClass.isValid || !validationResponse.projectName.isValid) {
            return this.fixMainClass(folder, config, validationResponse);
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
                               validationResponse: lsPlugin.ILaunchValidationResponse): Promise<lsPlugin.IMainClassOption | undefined> {
        const errors: string[] = [];
        if (!validationResponse.mainClass.isValid) {
            errors.push(String(validationResponse.mainClass.message));
        }

        if (!validationResponse.projectName.isValid) {
            errors.push(String(validationResponse.projectName.message));
        }

        if (validationResponse.proposals && validationResponse.proposals.length) {
            const answer = await utility.showErrorMessageWithTroubleshooting({
                message: errors.join(os.EOL),
                type: Type.USAGEERROR,
                anchor: anchor.FAILED_TO_RESOLVE_CLASSPATH,
            }, "Fix");
            if (answer === "Fix") {
                const pickItems: IMainClassQuickPickItem[] = this.formatMainClassOptions(validationResponse.proposals);
                const selectedFix: lsPlugin.IMainClassOption =
                    await this.showMainClassQuickPick(pickItems, "Please select main class<project name>.", false);
                if (selectedFix) {
                    logger.log(Type.USAGEDATA, {
                        fix: "yes",
                        fixMessage: errors.join(os.EOL),
                    });
                    await this.persistMainClassOption(folder, config, selectedFix);
                }

                return selectedFix;
            }
            // return undefined if the user clicks "Learn More".
            return;
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

    private async promptMainClass(folder: vscode.Uri | undefined, hintMessage?: string): Promise<lsPlugin.IMainClassOption | undefined> {
        const res = await lsPlugin.resolveMainClass(folder);
        if (res.length === 0) {
            throw new utility.UserError({
                message: "Cannot find a class with the main method.",
                type: Type.USAGEERROR,
                anchor: anchor.CANNOT_FIND_MAIN_CLASS,
            });
        }

        const pickItems: IMainClassQuickPickItem[] = this.formatRecentlyUsedMainClassOptions(res);
        const selected = await this.showMainClassQuickPick(pickItems, hintMessage || "Select main class<project name>");
        if (selected) {
            this.debugHistory.updateMRUTimestamp(selected);
        }

        return selected;
    }

    private async showMainClassQuickPick(pickItems: IMainClassQuickPickItem[], quickPickHintMessage: string, autoPick: boolean = true):
        Promise<lsPlugin.IMainClassOption | undefined> {
        // return undefined when the user cancels QuickPick by pressing ESC.
        const selected = (pickItems.length === 1 && autoPick) ?
            pickItems[0] : await vscode.window.showQuickPick(pickItems, { placeHolder: quickPickHintMessage });

        return selected && selected.item;
    }

    private formatRecentlyUsedMainClassOptions(options: lsPlugin.IMainClassOption[]): IMainClassQuickPickItem[] {
        // Sort the Main Class options with the recently used timestamp.
        options.sort((a: lsPlugin.IMainClassOption, b: lsPlugin.IMainClassOption) => {
            return this.debugHistory.getMRUTimestamp(b) - this.debugHistory.getMRUTimestamp(a);
        });

        const mostRecentlyUsedOption: lsPlugin.IMainClassOption = (options.length && this.debugHistory.contains(options[0])) ? options[0] : undefined;
        const isMostRecentlyUsed = (option: lsPlugin.IMainClassOption): boolean => {
            return mostRecentlyUsedOption
                && mostRecentlyUsedOption.mainClass === option.mainClass
                && mostRecentlyUsedOption.projectName === option.projectName;
        };
        const isFromActiveEditor = (option: lsPlugin.IMainClassOption): boolean => {
            const activeEditor: vscode.TextEditor = vscode.window.activeTextEditor;
            const currentActiveFile: string = _.get(activeEditor, "document.uri.fsPath");
            return option.filePath && currentActiveFile && path.relative(option.filePath, currentActiveFile) === "";
        };
        const isPrivileged = (option: lsPlugin.IMainClassOption): boolean => {
            return isMostRecentlyUsed(option) || isFromActiveEditor(option);
        };

        // Show the most recently used Main Class as the first one,
        // then the Main Class from Active Editor as second,
        // finally other Main Class.
        const adjustedOptions: lsPlugin.IMainClassOption[] = [];
        options.forEach((option: lsPlugin.IMainClassOption) => {
            if (isPrivileged(option)) {
                adjustedOptions.push(option);
            }
        });
        options.forEach((option: lsPlugin.IMainClassOption) => {
            if (!isPrivileged(option)) {
                adjustedOptions.push(option);
            }
        });

        const pickItems: IMainClassQuickPickItem[] = this.formatMainClassOptions(adjustedOptions);
        pickItems.forEach((pickItem: IMainClassQuickPickItem) => {
            const adjustedDetail = [];
            if (isMostRecentlyUsed(pickItem.item)) {
                adjustedDetail.push("$(clock) recently used");
            }

            if (isFromActiveEditor(pickItem.item)) {
                adjustedDetail.push(`$(file-text) active editor (${path.basename(pickItem.item.filePath)})`);
            }

            pickItem.detail = adjustedDetail.join(", ");
        });

        return pickItems;
    }

    private formatMainClassOptions(options: lsPlugin.IMainClassOption[]): IMainClassQuickPickItem[] {
        return options.map((item) => {
            let label = item.mainClass;
            const description = item.filePath ? path.basename(item.filePath) : "";
            if (item.projectName) {
                label += `<${item.projectName}>`;
            }

            return {
                label,
                description,
                detail: null,
                item,
            };
        });
    }
}

async function updateDebugSettings(config?: vscode.DebugConfiguration | undefined) {
    const debugSettingsRoot: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("java.debug");
    if (!debugSettingsRoot) {
        return;
    }
    const logLevel = convertLogLevel(debugSettingsRoot.logLevel || "");
    const javaHome = (config && config.javaHome) ? config.javaHome : await utility.getJavaHome();
    if (debugSettingsRoot.settings && Object.keys(debugSettingsRoot.settings).length) {
        try {
            // tslint:disable-next-line:no-console
            console.log("settings:", await commands.executeJavaLanguageServerCommand(commands.JAVA_UPDATE_DEBUG_SETTINGS, JSON.stringify(
                { ...debugSettingsRoot.settings, logLevel, javaHome })));
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

export interface IMainClassQuickPickItem extends vscode.QuickPickItem {
    item: lsPlugin.IMainClassOption;
}

class MostRecentlyUsedHistory {
    private cache: { [key: string]: number } = {};

    public getMRUTimestamp(mainClassOption: lsPlugin.IMainClassOption): number {
        return this.cache[this.getKey(mainClassOption)] || 0;
    }

    public updateMRUTimestamp(mainClassOption: lsPlugin.IMainClassOption): void {
        this.cache[this.getKey(mainClassOption)] = Date.now();
    }

    public contains(mainClassOption: lsPlugin.IMainClassOption): boolean {
        return Boolean(this.cache[this.getKey(mainClassOption)]);
    }

    private getKey(mainClassOption: lsPlugin.IMainClassOption): string {
        return mainClassOption.mainClass + "|" + mainClassOption.projectName;
    }
}
