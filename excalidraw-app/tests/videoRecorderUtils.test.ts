import { describe, expect, it, beforeEach } from "vitest";

import { STORAGE_KEYS } from "../app_constants";
import {
  loadVideoRecorderSettings,
  saveVideoRecorderSettings,
} from "../components/video-recorder/videoRecorder.storage";
import {
  clampOverlayLayout,
  getFileExtensionFromMimeType,
  getVideoDimensions,
} from "../components/video-recorder/videoRecorder.utils";

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
