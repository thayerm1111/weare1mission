/** A display preference only. It never changes engine, access, billing or account settings. */
export type ExperienceMode = "simple" | "advanced";
export const EXPERIENCE_KEY = "om:experience-mode";
export const DEFAULT_EXPERIENCE: ExperienceMode = "simple";
export function experienceModeOf(value: unknown): ExperienceMode {
  return value === "advanced" ? "advanced" : DEFAULT_EXPERIENCE;
}
