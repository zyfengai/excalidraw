import { STORAGE_KEYS } from "../../app_constants";

import { getDefaultVideoRecorderSettings } from "./videoRecorder.config";
import { clampOverlayLayout, clamp } from "./videoRecorder.utils";

import type { VideoRecorderSettings } from "./videoRecorder.types";

const VIDEO_RECORDER_SETTINGS_VERSION = 1;

type PersistedVideoRecorderSettings = {
  version: number;
  settings: VideoRecorderSettings;
};

const coerceSettings = (value: unknown): VideoRecorderSettings | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const next = value as Partial<VideoRecorderSettings>;
  const defaults = getDefaultVideoRecorderSettings();

  return {
    ...defaults,
    ...next,
    mimeType: next.mimeType || defaults.mimeType,
    camera: clampOverlayLayout({
      ...defaults.camera,
      ...(next.camera || {}),
    }),
    teleprompter: {
      ...defaults.teleprompter,
      ...(next.teleprompter || {}),
      opacity: clamp(
        next.teleprompter?.opacity ?? defaults.teleprompter.opacity,
        0.05,
        1,
      ),
      speed: clamp(
        next.teleprompter?.speed ?? defaults.teleprompter.speed,
        5,
        250,
      ),
    },
  };
};

export const loadVideoRecorderSettings = (): VideoRecorderSettings => {
  const defaults = getDefaultVideoRecorderSettings();
  try {
    const value = localStorage.getItem(
      STORAGE_KEYS.LOCAL_STORAGE_VIDEO_RECORDER,
    );
    if (!value) {
      return defaults;
    }

    const parsed = JSON.parse(value) as PersistedVideoRecorderSettings;
    if (!parsed || parsed.version !== VIDEO_RECORDER_SETTINGS_VERSION) {
      return defaults;
    }

    return coerceSettings(parsed.settings) || defaults;
  } catch (error) {
    console.error(error);
    return defaults;
  }
};

export const saveVideoRecorderSettings = (settings: VideoRecorderSettings) => {
  try {
    const payload: PersistedVideoRecorderSettings = {
      version: VIDEO_RECORDER_SETTINGS_VERSION,
      settings,
    };
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_VIDEO_RECORDER,
      JSON.stringify(payload),
    );
  } catch (error) {
    console.error(error);
  }
};
