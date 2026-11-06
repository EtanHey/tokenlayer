// Compile-only consumer contract. Never called; no file reads.
import { projectGeminiJson, readGeminiJson, projectGeminiJsonWithProfile, readGeminiJsonWithProfile, GEMINI_LARGE_DOCUMENT_PROFILE, type GeminiLimits, type GeminiFilePin } from "../../src/metadata/gemini-json";
export function lowerBudgetConsumer(raw: Buffer, path: string, pin: GeminiFilePin) {
  const limits: Partial<GeminiLimits> = { bytes: 128, depth: 8, tokens: 100, messages: 1, milliseconds: 1 };
  projectGeminiJson(raw, limits);
  readGeminiJson(path, pin, limits);
  projectGeminiJson(raw, { depth: 4, tokens: 50, messages: 1, milliseconds: 2 });
  readGeminiJson(path, pin, { depth: 4, tokens: 50, messages: 1, milliseconds: 2 });
  projectGeminiJsonWithProfile(raw, GEMINI_LARGE_DOCUMENT_PROFILE, limits);
  readGeminiJsonWithProfile(path, pin, GEMINI_LARGE_DOCUMENT_PROFILE, limits);
  // @ts-expect-error Profile selection is closed.
  projectGeminiJsonWithProfile(raw, "large-document-32mib-v1");
  // @ts-expect-error String budgets must remain invalid.
  projectGeminiJson(raw, { milliseconds: "1" });
  // @ts-expect-error Unknown options must remain invalid.
  readGeminiJson(path, pin, { unknownBudget: 1 });
}
