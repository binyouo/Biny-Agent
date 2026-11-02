/** Automatic ordinary-model discovery is narrower than factual model metadata. */
export function isOrdinaryCatalogModelSupported(modelId: string, api: string, baseUrl: string | undefined): boolean {
  // These exact Google agent IDs require Interactions, not ordinary model calls.
  // Keep explicit configured aliases and raw metadata outside this projection.
  if ((modelId !== "deep-research-preview-04-2026" && modelId !== "deep-research-max-preview-04-2026")
    || (api !== "chat_completions" && api !== "google_generative_ai")) return true;
  // A provider alias/type alone cannot establish a third-party API contract.
  // Unknown endpoints and extension backends may implement their own adapter.
  const endpoint = baseUrl?.replace(/\/$/u, "");
  return endpoint !== "https://generativelanguage.googleapis.com/v1beta"
    && endpoint !== "https://generativelanguage.googleapis.com/v1beta/openai";
}
