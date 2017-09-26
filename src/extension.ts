// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as path from "path";
import * as vscode from "vscode";
import TelemetryReporter from "vscode-extension-telemetry";
import * as commands from "./commands";

const status: any = {};

export function activate(context: vscode.ExtensionContext) {
    vscode.commands.registerCommand(commands.JAVA_START_DEBUGSESSION, async (config) => {

        if (!status.debugging) {
            status.debugging = "startDebugSession";

            try {
                try {
                    const level = await configLogLevel(vscode.workspace.getConfiguration().get("java.debug.logLevel"));
                    console.log("setting log level to ", level);
                } catch (err) {
                    // log a warning message and contiue, since logger failure should not block debug session
                    console.log("Cannot set log level to java debuggeer.")
                }
                if (Object.keys(config).length === 0) { // No launch.json in current workspace.
                    const ans = await vscode.window.showInformationMessage(
                        "\"launch.json\" is needed to start the debugger. Do you want to create it now?", "Yes", "No");
                    if (ans === "Yes") {
                        vscode.commands.executeCommand(commands.VSCODE_ADD_DEBUGCONFIGURATION);
                    }
                    return;
                } else if (config.request === "launch") {
                    if (!config.mainClass) {
                        vscode.window.showErrorMessage("Please specify the mainClass in the launch.json.");
                        return;
                    } else if (!config.classPaths || !Array.isArray(config.classPaths) || !config.classPaths.length) {
                        config.classPaths = await resolveClasspath(config.mainClass, config.projectName);
                    }
                    if (!config.classPaths || !Array.isArray(config.classPaths) || !config.classPaths.length) {
                        vscode.window.showErrorMessage("Cannot resolve the classpaths automatically, please specify the value in the launch.json.");
                        return;
                    }
                } else if (config.request === "attach") {
                    if (!config.hostName || !config.port) {
                        vscode.window.showErrorMessage("Please specify the host name and the port of the remote debuggee in the launch.json.");
                        return;
                    }
                } else {
                    const ans = await vscode.window.showErrorMessage(
                        // tslint:disable-next-line:max-line-length
                        "Request type \"" + config.request + "\" is not supported. Only \"launch\" and \"attach\" are supported.", "Open launch.json");
                    if (ans === "Open launch.json") {
                        await vscode.commands.executeCommand(commands.VSCODE_ADD_DEBUGCONFIGURATION);
                    }
                    return;
                }
                const debugServerPort = await startDebugSession();
                if (debugServerPort) {
                    config.debugServer = debugServerPort;
                    await vscode.commands.executeCommand(commands.VSCODE_STARTDEBUG, config);
                } else {
                    // Information for diagnostic:
                    console.log("Cannot find a port for debugging session");
                }
            } catch (ex) {

            } finally {
                delete status.debugging;
            }
        }
    });

    // Telemetry.
    const extensionPackage = require(context.asAbsolutePath("./package.json"));
    if (extensionPackage) {
        const packageInfo = {
            name: extensionPackage.name,
            version: extensionPackage.version,
            aiKey: extensionPackage.aiKey,
        };
        if (packageInfo.aiKey) {
            const reporter = new TelemetryReporter(packageInfo.name, packageInfo.version, packageInfo.aiKey);
            vscode.debug.onDidTerminateDebugSession(() => {
                fetchUsageData().then((ret) => {
                    if (Array.isArray(ret) && ret.length) {
                        ret.forEach((entry) => {
                            const props = {};
                            const measures = {};
                            for (let name in entry) {
                                if (typeof entry[name] === "number") {
                                    measures[name] = entry[name];
                                } else {
                                    props[name] = String(entry[name]);
                                }
                            }
                            reporter.sendTelemetryEvent("usageData", props, measures);
                        });
                    }
                });
            });
        }
    }
}

// this method is called when your extension is deactivated
export function deactivate() {
}

function startDebugSession() {
    return executeJavaLanguageServerCommand(commands.JAVA_START_DEBUGSESSION);
}

function resolveClasspath(mainClass, projectName) {
    return executeJavaLanguageServerCommand(commands.JAVA_RESOLVE_CLASSPATH, mainClass, projectName);
}

function fetchUsageData() {
    return executeJavaLanguageServerCommand(commands.JAVA_FETCH_USAGE_DATA);
}

function executeJavaLanguageServerCommand(...rest) {
    return vscode.commands.executeCommand(commands.JAVA_EXECUTE_WORKSPACE_COMMAND, ...rest);
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
