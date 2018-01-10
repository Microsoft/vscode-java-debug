// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";

const suppressedReasons: Set<string> = new Set();

const NOT_SHOW_AGAIN: string = "Not show again";

const JAVA_LANGID: string = "java";

const HCR_EVENT = "hotcodereplace";

enum HcrChangeType {
    ERROR = "ERROR",
    WARNING = "WARNING",
    STARTING = "STARTING",
    END = "END",
    BUILD_COMPLETE = "BUILD_COMPLETE",
}

export function initializeHotCodeReplace(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession((session) => {
        const t = session ? session.type : undefined;
        if (t === JAVA_LANGID) {
            suppressedReasons.clear();
        }
    }));

    context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent((customEvent) => {
        const t = customEvent.session ? customEvent.session.type : undefined;
        if (t !== JAVA_LANGID || customEvent.event !== HCR_EVENT) {
            return;
        }

        if (customEvent.body.changeType === HcrChangeType.BUILD_COMPLETE) {
            return vscode.window.withProgress({location: vscode.ProgressLocation.Window}, (progress) => {
                progress.report({message: "Applying code changes..."});
                return customEvent.session.customRequest("redefineClasses");
            });
        }

        if (customEvent.body.changeType === HcrChangeType.ERROR || customEvent.body.changeType === HcrChangeType.WARNING) {
            if (!suppressedReasons.has(customEvent.body.message)) {
                vscode.window.showInformationMessage(`Hot code replace failed - ${customEvent.body.message}`, NOT_SHOW_AGAIN).then((res) => {
                    if (res === NOT_SHOW_AGAIN) {
                        suppressedReasons.add(customEvent.body.message);
                    }
                });
            }
        }
    }));
}
