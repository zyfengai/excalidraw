import { beforeEach, describe, expect, it, vi } from "vitest";

import { STORAGE_KEYS } from "../app_constants";
import {
  loadVideoRecorderSettings,
  saveVideoRecorderSettings,
} from "../components/video-recorder/videoRecorder.storage";
import {
  clampOverlayLayout,
  getFileExtensionFromMimeType,
  getPermissionRequestConstraints,
  normalizeRecorderAspectRatio,
  normalizeRecorderFps,
  normalizeRecorderMimeType,
  normalizeRecorderResolution,
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

  it("falls back to default dimensions for unsupported profile values", () => {
    expect(
      getVideoDimensions(
        "unknown-ratio" as unknown as Parameters<typeof getVideoDimensions>[0],
        "unknown-resolution" as unknown as Parameters<
          typeof getVideoDimensions
        >[1],
      ),
    ).toEqual({
      width: 1920,
      height: 1080,
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

  it("normalizes circle camera overlay layout to square bounds", () => {
    expect(
      clampOverlayLayout({
        x: 0.95,
        y: 0.92,
        width: 0.2,
        height: 0.45,
        shape: "circle",
      }),
    ).toEqual({
      x: 0.55,
      y: 0.55,
      width: 0.45,
      height: 0.45,
      shape: "circle",
    });
  });

  it("derives extension from mime type", () => {
    expect(getFileExtensionFromMimeType("video/mp4")).toBe("mp4");
    expect(getFileExtensionFromMimeType("VIDEO/MP4;CODECS=AVC1")).toBe("mp4");
    expect(getFileExtensionFromMimeType(" video/mp4 ; codecs=avc1 ")).toBe(
      "mp4",
    );
    expect(getFileExtensionFromMimeType("video/webm;codecs=vp9,opus")).toBe(
      "webm",
    );
    expect(
      getFileExtensionFromMimeType("video/webm;codecs=vp9,mp4a.40.2"),
    ).toBe("webm");
  });

  it("normalizes mime type against browser support", () => {
    const supportedMimeTypes = ["video/webm;codecs=vp9,opus", "video/mp4"];

    expect(
      normalizeRecorderMimeType("video/mp4", ["video/webm", "video/mp4"]),
    ).toBe("video/mp4");
    expect(
      normalizeRecorderMimeType(" VIDEO/MP4 ", ["video/webm", "video/mp4"]),
    ).toBe("video/mp4");
    expect(
      normalizeRecorderMimeType(
        "video/webm; codecs = vp9, opus",
        supportedMimeTypes,
      ),
    ).toBe("video/webm;codecs=vp9,opus");
    expect(normalizeRecorderMimeType("video/unknown", ["video/webm"])).toBe(
      "video/webm",
    );
    expect(normalizeRecorderMimeType("video/unknown", [])).toBe("");
  });

  it("normalizes fps to supported recording presets", () => {
    expect(normalizeRecorderFps(30, 24)).toBe(30);
    expect(normalizeRecorderFps(0, 24)).toBe(24);
    expect(normalizeRecorderFps(120, 24)).toBe(60);
    expect(normalizeRecorderFps(29.6, 24)).toBe(30);
    expect(normalizeRecorderFps(52, 24)).toBe(60);
    expect(normalizeRecorderFps(25, 60)).toBe(24);
    expect(normalizeRecorderFps(Number.NaN, 24)).toBe(24);
  });

  it("normalizes video profile options against known values", () => {
    expect(normalizeRecorderAspectRatio("4:3", "16:9")).toBe("4:3");
    expect(normalizeRecorderAspectRatio(" 4:3 ", "16:9")).toBe("4:3");
    expect(normalizeRecorderAspectRatio("4 : 3", "16:9")).toBe("4:3");
    expect(normalizeRecorderAspectRatio("weird", "16:9")).toBe("16:9");
    expect(normalizeRecorderResolution("720p", "1080p")).toBe("720p");
    expect(normalizeRecorderResolution(" 720p ", "1080p")).toBe("720p");
    expect(normalizeRecorderResolution("720 p", "1080p")).toBe("720p");
    expect(normalizeRecorderResolution("720P", "1080p")).toBe("720p");
    expect(normalizeRecorderResolution("4k", "1080p")).toBe("1080p");
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
        cameraEnabled: false,
        microphoneEnabled: false,
        selectedVideoDeviceId: "camera-1",
        selectedAudioDeviceId: "mic-1",
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
    vi.restoreAllMocks();
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

  it("falls back to defaults for invalid persisted version", () => {
    const defaults = getDefaultVideoRecorderSettings();
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_VIDEO_RECORDER,
      JSON.stringify({
        version: 999,
        settings: {
          ...defaults,
          cameraEnabled: true,
          aspectRatio: "4:3",
        },
      }),
    );

    expect(loadVideoRecorderSettings()).toEqual(defaults);
  });

  it("coerces persisted camera and teleprompter ranges", () => {
    const defaults = getDefaultVideoRecorderSettings();
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_VIDEO_RECORDER,
      JSON.stringify({
        version: 1,
        settings: {
          ...defaults,
          camera: {
            ...defaults.camera,
            x: -0.3,
            y: 2,
            width: 2,
            height: 0.01,
          },
          teleprompter: {
            ...defaults.teleprompter,
            opacity: 999,
            speed: 0,
          },
          fps: 999,
          aspectRatio: "invalid-ratio",
          resolution: "invalid-resolution",
        },
      }),
    );

    const loaded = loadVideoRecorderSettings();
    expect(loaded.camera).toEqual({
      x: 0,
      y: 0.9,
      width: 0.8,
      height: 0.1,
      shape: defaults.camera.shape,
    });
    expect(loaded.teleprompter.opacity).toBe(1);
    expect(loaded.teleprompter.speed).toBe(5);
    expect(loaded.fps).toBe(60);
    expect(loaded.aspectRatio).toBe(defaults.aspectRatio);
    expect(loaded.resolution).toBe(defaults.resolution);
  });

  it("coerces malformed persisted field types back to safe defaults", () => {
    const defaults = getDefaultVideoRecorderSettings();
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_VIDEO_RECORDER,
      JSON.stringify({
        version: 1,
        settings: {
          ...defaults,
          cameraEnabled: "yes",
          microphoneEnabled: 1,
          selectedVideoDeviceId: 123,
          selectedAudioDeviceId: "",
          mimeType: 42,
          camera: {
            x: "left",
            y: 0.25,
            width: "wide",
            height: 0.3,
            shape: "triangle",
          },
          teleprompter: {
            enabled: "true",
            text: 999,
            opacity: "opaque",
            speed: null,
          },
        },
      }),
    );

    const loaded = loadVideoRecorderSettings();
    expect(loaded.cameraEnabled).toBe(defaults.cameraEnabled);
    expect(loaded.microphoneEnabled).toBe(defaults.microphoneEnabled);
    expect(loaded.selectedVideoDeviceId).toBeNull();
    expect(loaded.selectedAudioDeviceId).toBeNull();
    expect(loaded.mimeType).toBe(defaults.mimeType);
    expect(loaded.camera).toEqual({
      x: defaults.camera.x,
      y: 0.25,
      width: defaults.camera.width,
      height: 0.3,
      shape: defaults.camera.shape,
    });
    expect(loaded.teleprompter).toEqual({
      ...defaults.teleprompter,
      enabled: defaults.teleprompter.enabled,
      text: defaults.teleprompter.text,
      opacity: defaults.teleprompter.opacity,
      speed: defaults.teleprompter.speed,
    });
  });

  it("trims persisted selected device ids", () => {
    const defaults = getDefaultVideoRecorderSettings();
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_VIDEO_RECORDER,
      JSON.stringify({
        version: 1,
        settings: {
          ...defaults,
          selectedVideoDeviceId: " camera-1 ",
          selectedAudioDeviceId: " mic-1 ",
        },
      }),
    );

    const loaded = loadVideoRecorderSettings();
    expect(loaded.selectedVideoDeviceId).toBe("camera-1");
    expect(loaded.selectedAudioDeviceId).toBe("mic-1");
  });

  it("returns defaults and logs when persisted json is malformed", () => {
    const defaults = getDefaultVideoRecorderSettings();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_VIDEO_RECORDER, "{");
    expect(loadVideoRecorderSettings()).toEqual(defaults);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("does not throw if saving to localStorage fails", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded");
      });

    expect(() =>
      saveVideoRecorderSettings(getDefaultVideoRecorderSettings()),
    ).not.toThrow();
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
