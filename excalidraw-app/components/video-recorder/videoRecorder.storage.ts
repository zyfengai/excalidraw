import { STORAGE_KEYS } from "../../app_constants";

import { getDefaultVideoRecorderSettings } from "./videoRecorder.config";
import {
  clampOverlayLayout,
  clamp,
  normalizeRecorderFps,
  normalizeRecorderAspectRatio,
  normalizeRecorderResolution,
} from "./videoRecorder.utils";

import type { VideoRecorderSettings } from "./videoRecorder.types";

const VIDEO_RECORDER_SETTINGS_VERSION = 1;

type PersistedVideoRecorderSettings = {
  version: number;
  settings: VideoRecorderSettings;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object";

const asBoolean = (value: unknown, fallback: boolean) =>
  typeof value === "boolean" ? value : fallback;

const asString = (value: unknown, fallback: string) =>
  typeof value === "string" ? value : fallback;

const asNumber = (value: unknown, fallback: number) =>
  typeof value === "number" ? value : fallback;

const asNullableDeviceId = (value: unknown) =>
  typeof value === "string" && value.trim().length ? value : null;

const asCameraShape = (
  value: unknown,
  fallback: VideoRecorderSettings["camera"]["shape"],
) =>
  value === "rectangle" || value === "rounded" || value === "circle"
    ? value
    : fallback;

const coerceSettings = (value: unknown): VideoRecorderSettings | null => {
  if (!isObject(value)) {
    return null;
  }

  const next = value as Record<string, unknown>;
  const defaults = getDefaultVideoRecorderSettings();
  const cameraInput = isObject(next.camera) ? next.camera : {};
  const teleprompterInput = isObject(next.teleprompter)
    ? next.teleprompter
    : {};

  return {
    cameraEnabled: asBoolean(next.cameraEnabled, defaults.cameraEnabled),
    microphoneEnabled: asBoolean(
      next.microphoneEnabled,
      defaults.microphoneEnabled,
    ),
    selectedVideoDeviceId: asNullableDeviceId(next.selectedVideoDeviceId),
    selectedAudioDeviceId: asNullableDeviceId(next.selectedAudioDeviceId),
    aspectRatio: normalizeRecorderAspectRatio(
      asString(next.aspectRatio, defaults.aspectRatio),
      defaults.aspectRatio,
    ),
    resolution: normalizeRecorderResolution(
      asString(next.resolution, defaults.resolution),
      defaults.resolution,
    ),
    mimeType: asString(next.mimeType, defaults.mimeType),
    fps: normalizeRecorderFps(asNumber(next.fps, defaults.fps), defaults.fps),
    camera: clampOverlayLayout({
      ...defaults.camera,
      x: asNumber(cameraInput.x, defaults.camera.x),
      y: asNumber(cameraInput.y, defaults.camera.y),
      width: asNumber(cameraInput.width, defaults.camera.width),
      height: asNumber(cameraInput.height, defaults.camera.height),
      shape: asCameraShape(cameraInput.shape, defaults.camera.shape),
    }),
    teleprompter: {
      ...defaults.teleprompter,
      enabled: asBoolean(
        teleprompterInput.enabled,
        defaults.teleprompter.enabled,
      ),
      text: asString(teleprompterInput.text, defaults.teleprompter.text),
      opacity: clamp(
        asNumber(teleprompterInput.opacity, defaults.teleprompter.opacity),
        0.05,
        1,
      ),
      speed: clamp(
        asNumber(teleprompterInput.speed, defaults.teleprompter.speed),
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
