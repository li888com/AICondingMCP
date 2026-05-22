export type RequirementResolution = {
  requirementId: number | null;
  source: "prompt" | "context" | "empty";
};

export function extractRequirementId(promptText?: string | null): number | null {
  if (!promptText) return null;

  const match = promptText.match(/#\s*([1-9]\d*)\b/);
  if (!match) return null;

  const parsed = Number(match[1]);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Requirement id #${match[1]} is too large`);
  }

  return parsed;
}

export function resolveRequirementId(
  promptText: string | null | undefined,
  contextRequirementId: number | null
): RequirementResolution {
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
