import { describe, expect, it, beforeEach } from "vitest";

import { STORAGE_KEYS } from "../app_constants";
import {
  loadVideoRecorderSettings,
  saveVideoRecorderSettings,
} from "../components/video-recorder/videoRecorder.storage";
import {
  clampOverlayLayout,
  getFileExtensionFromMimeType,
  getPermissionRequestConstraints,
  normalizeRecorderMimeType,
  getVideoDimensions,
} from "../components/video-recorder/videoRecorder.utils";
import { getDefaultVideoRecorderSettings } from "../components/video-recorder/videoRecorder.config";

describe("video recorder utils", () => {
  it("computes landscape dimensions", () => {
    expect(getVideoDimensions("16:9", "720p")).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it("computes portrait dimensions", () => {
    expect(getVideoDimensions("9:16", "720p")).toEqual({
      width: 720,
      height: 1280,
    });
  });

  it("clamps camera overlay layout into valid range", () => {
    expect(
      clampOverlayLayout({
        x: -0.2,
        y: 1.2,
        width: 1.5,
        height: 0.02,
        shape: "rectangle",
      }),
    ).toEqual({
      x: 0,
      y: 0.9,
      width: 0.8,
      height: 0.1,
      shape: "rectangle",
    });
  });

  it("derives extension from mime type", () => {
    expect(getFileExtensionFromMimeType("video/mp4")).toBe("mp4");
    expect(getFileExtensionFromMimeType("video/webm;codecs=vp9,opus")).toBe(
      "webm",
    );
  });

  it("normalizes mime type against browser support", () => {
    expect(
      normalizeRecorderMimeType("video/mp4", ["video/webm", "video/mp4"]),
    ).toBe("video/mp4");
    expect(normalizeRecorderMimeType("video/unknown", ["video/webm"])).toBe(
      "video/webm",
    );
    expect(normalizeRecorderMimeType("video/unknown", [])).toBe("");
  });

  it("builds permission constraints from settings", () => {
    const defaults = getDefaultVideoRecorderSettings();
    expect(getPermissionRequestConstraints(defaults)).toEqual({
      audio: true,
      video: false,
    });

    expect(
      getPermissionRequestConstraints({
        ...defaults,
        cameraEnabled: false,
        microphoneEnabled: false,
      }),
    ).toEqual({
      audio: true,
      video: true,
    });

    expect(
      getPermissionRequestConstraints({
        ...defaults,
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "camera-1",
      }),
    ).toEqual({
      video: { deviceId: { exact: "camera-1" } },
      audio: false,
    });

    expect(
      getPermissionRequestConstraints({
        ...defaults,
        cameraEnabled: false,
        microphoneEnabled: true,
        selectedAudioDeviceId: "mic-1",
      }),
    ).toEqual({
      video: false,
      audio: { deviceId: { exact: "mic-1" } },
    });
  });
});

describe("video recorder settings storage", () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_VIDEO_RECORDER);
  });

  it("round-trips settings from localStorage", () => {
    const initial = loadVideoRecorderSettings();
    const next = {
      ...initial,
      aspectRatio: "4:3" as const,
      resolution: "720p" as const,
      cameraEnabled: true,
      camera: {
        ...initial.camera,
        x: 0.2,
        y: 0.3,
        width: 0.35,
        height: 0.35,
        shape: "circle" as const,
      },
    };

    saveVideoRecorderSettings(next);

    expect(loadVideoRecorderSettings()).toMatchObject(next);
  });
});
