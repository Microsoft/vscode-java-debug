// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import TelemetryReporter from "vscode-extension-telemetry";
import * as commands from "./commands";

export class JavaDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    constructor(private _reporter: TelemetryReporter) {
    }

    // Returns an initial debug configurations based on contextual information.
    public provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined, token?: vscode.CancellationToken):
        vscode.ProviderResult<vscode.DebugConfiguration[]> {
        return [{
            type: "java",
            name: "Debug (Launch)",
            request: "launch",
            mainClass: "",
            args: "",
        }, {
            type: "java",
            name: "Debug (Attach)",
            request: "attach",
            hostName: "localhost",
            port: 0,
        }];
    }

    // Try to add all missing attributes to the debug configuration being launched.
    public resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken):
        vscode.ProviderResult<vscode.DebugConfiguration> {
        return this.heuristicallyResolveDebugConfiguration(folder, config);
    }

    private async heuristicallyResolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration) {
        try {
            try {
                const level = await configLogLevel(vscode.workspace.getConfiguration().get("java.debug.logLevel"));
                console.log("setting log level to ", level);
            } catch (err) {
                // log a warning message and continue, since logger failure should not block debug session
                console.log("Cannot set log level to java debuggeer.")
            }
            if (Object.keys(config).length === 0) { // No launch.json in current workspace.
                this.log("usageError", "No launch.json.");
                const ans = await vscode.window.showInformationMessage(
                    "\"launch.json\" is needed to start the debugger. Do you want to create it now?", "Yes", "No");
                if (ans === "Yes") {
                    vscode.commands.executeCommand(commands.VSCODE_ADD_DEBUGCONFIGURATION);
                }
                return undefined;
            } else if (config.request === "launch") {
                if (!config.mainClass) {
                    vscode.window.showErrorMessage("Please specify the mainClass in the launch.json.");
                    this.log("usageError", "Please specify the mainClass in the launch.json.");
                    return undefined;
                } else if (!config.classPaths || !Array.isArray(config.classPaths) || !config.classPaths.length) {
                    config.classPaths = await resolveClasspath(config.mainClass, config.projectName);
                }
                if (!config.classPaths || !Array.isArray(config.classPaths) || !config.classPaths.length) {
                    vscode.window.showErrorMessage("Cannot resolve the classpaths automatically, please specify the value in the launch.json.");
                    this.log("usageError", "Cannot resolve the classpaths automatically, please specify the value in the launch.json.");
                    return undefined;
                }
            } else if (config.request === "attach") {
                if (!config.hostName || !config.port) {
                    vscode.window.showErrorMessage("Please specify the host name and the port of the remote debuggee in the launch.json.");
                    this.log("usageError", "Please specify the host name and the port of the remote debuggee in the launch.json.");
                    return undefined;
                }
            } else {
                const ans = await vscode.window.showErrorMessage(
                    // tslint:disable-next-line:max-line-length
                    "Request type \"" + config.request + "\" is not supported. Only \"launch\" and \"attach\" are supported.", "Open launch.json");
                if (ans === "Open launch.json") {
                    await vscode.commands.executeCommand(commands.VSCODE_ADD_DEBUGCONFIGURATION);
                }
                this.log("usageError", "Illegal request type in launch.json");
                return undefined;
            }
            const debugServerPort = await startDebugSession();
            if (debugServerPort) {
                config.debugServer = debugServerPort;
                return config;
            } else {
                this.log("exception", "Failed to start debug server.");
                // Information for diagnostic:
                console.log("Cannot find a port for debugging session");
                return undefined;
            }
        } catch (ex) {
            const errorMessage = (ex && ex.message) || ex;
            vscode.window.showErrorMessage(errorMessage);
            if (this._reporter) {
                const exception = (ex && ex.data && ex.data.cause)
                    || { stackTrace: [], detailMessage: String((ex && ex.message) || ex || "Unknown exception") };
                const properties = {
                    message: "",
                    stackTrace: "",
                };
                if (exception && typeof exception === "object") {
                    properties.message = exception.detailMessage;
                    properties.stackTrace = (Array.isArray(exception.stackTrace) && JSON.stringify(exception.stackTrace))
                        || String(exception.stackTrace);
                } else {
                    properties.message = String(exception);
                }
                this._reporter.sendTelemetryEvent("exception", properties);
            }
            return undefined;
        }
    }

    private log(type: string, message: string) {
        if (this._reporter) {
            this._reporter.sendTelemetryEvent(type, { message });
        }
    }
}

export function executeJavaLanguageServerCommand(...rest) {
    // TODO: need to handle error and trace telemetry
    return vscode.commands.executeCommand(commands.JAVA_EXECUTE_WORKSPACE_COMMAND, ...rest);
}

function startDebugSession() {
    return executeJavaLanguageServerCommand(commands.JAVA_START_DEBUGSESSION);
}

function resolveClasspath(mainClass, projectName) {
    return executeJavaLanguageServerCommand(commands.JAVA_RESOLVE_CLASSPATH, mainClass, projectName);
}

function configLogLevel(level) {
    return executeJavaLanguageServerCommand(commands.JAVA_CONFIG_LOG_LEVEL, convertLogLevel(level));
}

function convertLogLevel(commonLogLevel: string) {
    // convert common log level to java log level
    switch (commonLogLevel.toLowerCase())  {
        case "verbose" :
            return "FINE";
        case "warn" :
            return "WARNING";
        case "error" :
            return "SEVERE";
        case "info" :
            return "INFO";
        default:
            return "FINE";
    }
}
