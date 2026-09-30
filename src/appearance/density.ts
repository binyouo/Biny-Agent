import type { AppearanceDensity } from "./types.js";

export const DENSITY_TOKENS: Record<AppearanceDensity, Record<string, string>> = {
  compact: {
    "--ui-density-line-height": "1.4",
    "--ui-density-card-padding": "1.25rem",
    "--ui-density-card-gap": "1rem",
    "--ui-density-control-height-default": "2.25rem",
    "--ui-density-control-height-sm": "2rem",
    "--ui-density-control-height-lg": "2.5rem",
    "--ui-density-control-padding-x": "0.9rem",
    "--ui-density-control-padding-y": "0.4rem",
    "--ui-density-stack-gap": "0.75rem",
    "--ui-density-control-gap": "0.4rem"
  },
  comfortable: {
    "--ui-density-line-height": "1.5",
    "--ui-density-card-padding": "1.5rem",
    "--ui-density-card-gap": "1.25rem",
    "--ui-density-control-height-default": "2.5rem",
    "--ui-density-control-height-sm": "2.25rem",
    "--ui-density-control-height-lg": "2.75rem",
    "--ui-density-control-padding-x": "1rem",
    "--ui-density-control-padding-y": "0.55rem",
    "--ui-density-stack-gap": "1rem",
    "--ui-density-control-gap": "0.5rem"
  },
  spacious: {
    "--ui-density-line-height": "1.65",
    "--ui-density-card-padding": "1.75rem",
    "--ui-density-card-gap": "1.5rem",
    "--ui-density-control-height-default": "2.75rem",
    "--ui-density-control-height-sm": "2.4rem",
    "--ui-density-control-height-lg": "3rem",
    "--ui-density-control-padding-x": "1.2rem",
    "--ui-density-control-padding-y": "0.75rem",
    "--ui-density-stack-gap": "1.35rem",
    "--ui-density-control-gap": "0.65rem"
  }
};
