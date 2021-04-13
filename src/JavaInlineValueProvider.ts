// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as compareVersions from "compare-versions";
import { debug, InlineValue, InlineValueContext, InlineValueEvaluatableExpression, InlineValuesProvider, InlineValueText, InlineValueVariableLookup,
    Range, TextDocument, version } from "vscode";
import * as CodeConverter from "vscode-languageclient/lib/codeConverter";
import * as ProtocolConverter from "vscode-languageclient/lib/protocolConverter";
import { InlineKind, InlineVariable, resolveInlineVariables } from "./languageServerPlugin";

// In VS Code 1.55.0, viewport doesn't change while scrolling the editor and it's fixed in 1.56.0.
// So dynamically enable viewport support based on the user's VS Code version.
const isViewPortSupported = compareVersions(version.replace(/-insider$/i, ""), "1.56.0") >= 0;

const protoConverter: ProtocolConverter.Converter = ProtocolConverter.createConverter();
const codeConverter: CodeConverter.Converter = CodeConverter.createConverter();

export class JavaInlineValuesProvider implements InlineValuesProvider {

    public async provideInlineValues(document: TextDocument, viewPort: Range, context: InlineValueContext): Promise<InlineValue[]> {
        const variables: InlineVariable[] = <InlineVariable[]> (await resolveInlineVariables({
            uri: document.uri.toString(),
            viewPort: isViewPortSupported ? codeConverter.asRange(viewPort) : undefined,
            stoppedLocation: codeConverter.asRange(context.stoppedLocation),
        }));
        if (!variables || !variables.length) {
            return [];
        }

        const unresolvedVariables: any[] = variables.filter((variable) => variable.kind === InlineKind.Evaluation).map((variable) => {
            return {
                expression: variable.expression || variable.name,
                declaringClass: variable.declaringClass,
            };
        });
        let resolvedVariables: any;
        if (unresolvedVariables.length && debug.activeDebugSession) {
            const response = await debug.activeDebugSession.customRequest("inlineValues", {
                frameId: context.frameId,
                variables: unresolvedVariables,
            });
            resolvedVariables = response?.variables;
        }

        const result: InlineValue[] = [];
        let next = 0;
        for (const variable of variables) {
            if (variable.kind === InlineKind.VariableLookup) {
                result.push(new InlineValueVariableLookup(protoConverter.asRange(variable.range), variable.name, true));
            } else if (resolvedVariables && resolvedVariables.length > next) {
                const resolvedValue = resolvedVariables[next++];
                if (resolvedValue) {
                    result.push(new InlineValueText(protoConverter.asRange(variable.range), `${variable.name} = ${resolvedValue.value}`));
                } else {
                    result.push(new InlineValueEvaluatableExpression(protoConverter.asRange(variable.range), variable.name));
                }
            } else {
                result.push(new InlineValueEvaluatableExpression(protoConverter.asRange(variable.range), variable.name));
            }
        }

        return result;
    }

}
