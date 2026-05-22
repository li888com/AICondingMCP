export function extractRequirementId(promptText) {
    if (!promptText)
        return null;
    const match = promptText.match(/#\s*([1-9]\d*)\b/);
    if (!match)
        return null;
    const parsed = Number(match[1]);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`Requirement id #${match[1]} is too large`);
    }
    return parsed;
}
export function resolveRequirementId(promptText, contextRequirementId) {
    const promptRequirementId = extractRequirementId(promptText);
    if (promptRequirementId !== null) {
        return {
            requirementId: promptRequirementId,
            source: "prompt"
        };
    }
    if (contextRequirementId !== null) {
        return {
            requirementId: contextRequirementId,
            source: "context"
        };
    }
    return {
        requirementId: null,
        source: "empty"
    };
}
