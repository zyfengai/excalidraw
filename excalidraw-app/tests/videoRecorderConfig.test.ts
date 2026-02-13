import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_VIDEO_RECORDER_CAMERA_LAYOUT,
  getDefaultVideoRecorderSettings,
  getVideoRecorderCapabilities,
} from "../components/video-recorder/videoRecorder.config";

const OriginalMediaRecorder = globalThis.MediaRecorder;

describe("video recorder capabilities", () => {
  afterEach(() => {
    if (OriginalMediaRecorder) {
      globalThis.MediaRecorder = OriginalMediaRecorder;
    } else {
      delete (globalThis as any).MediaRecorder;
    }
  });

  it("returns unsupported when MediaRecorder is missing", () => {
    delete (globalThis as any).MediaRecorder;
    const capabilities = getVideoRecorderCapabilities();
    expect(capabilities.isSupported).toBe(false);
    expect(capabilities.supportedMimeTypes).toEqual([]);
  });

  it("detects supported mime types", () => {
    class MockMediaRecorder {}
    (MockMediaRecorder as any).isTypeSupported = (mimeType: string) =>
      mimeType.includes("webm");

    globalThis.MediaRecorder = MockMediaRecorder as any;

    const capabilities = getVideoRecorderCapabilities();
    expect(capabilities.isSupported).toBe(true);
    expect(
      capabilities.supportedMimeTypes.every((mime) => mime.includes("webm")),
    ).toBe(true);
  });

  it("keeps recording supported when isTypeSupported is unavailable", () => {
    class MockMediaRecorder {}
    globalThis.MediaRecorder = MockMediaRecorder as any;

    const capabilities = getVideoRecorderCapabilities();
    expect(capabilities.isSupported).toBe(true);
    expect(capabilities.reason).toBe("mime-type-detection-not-supported");
    expect(capabilities.supportedMimeTypes).toEqual([]);
  });

  it("keeps recording supported when preferred mime list is empty", () => {
    class MockMediaRecorder {}
    (MockMediaRecorder as any).isTypeSupported = () => false;
    globalThis.MediaRecorder = MockMediaRecorder as any;

    const capabilities = getVideoRecorderCapabilities();
    expect(capabilities.isSupported).toBe(true);
    expect(capabilities.reason).toBe("no-supported-mime-type");
    expect(capabilities.supportedMimeTypes).toEqual([]);
  });

  it("ignores mime detection errors and keeps checking other formats", () => {
    class MockMediaRecorder {}
    (MockMediaRecorder as any).isTypeSupported = (mimeType: string) => {
      if (mimeType === "video/webm;codecs=vp9,opus") {
        throw new Error("detector failed");
      }
      return mimeType === "video/webm";
    };
    globalThis.MediaRecorder = MockMediaRecorder as any;

    const capabilities = getVideoRecorderCapabilities();
    expect(capabilities.isSupported).toBe(true);
    expect(capabilities.supportedMimeTypes).toEqual(["video/webm"]);
  });

  it("sets default mime type from capabilities", () => {
    class MockMediaRecorder {}
    (MockMediaRecorder as any).isTypeSupported = (mimeType: string) =>
      mimeType === "video/webm";
    globalThis.MediaRecorder = MockMediaRecorder as any;

    const defaults = getDefaultVideoRecorderSettings();
    expect(defaults.mimeType).toBe("video/webm");
  });

  it("falls back to webm default mime when support probing is unavailable", () => {
    class MockMediaRecorder {}
    globalThis.MediaRecorder = MockMediaRecorder as any;

    const defaults = getDefaultVideoRecorderSettings();
    expect(defaults.mimeType).toBe("video/webm");
  });

  it("uses expected default camera layout", () => {
    class MockMediaRecorder {}
    (MockMediaRecorder as any).isTypeSupported = () => true;
    globalThis.MediaRecorder = MockMediaRecorder as any;

    const defaults = getDefaultVideoRecorderSettings();
    expect(defaults.camera).toEqual(DEFAULT_VIDEO_RECORDER_CAMERA_LAYOUT);
    expect(defaults.camera).not.toBe(DEFAULT_VIDEO_RECORDER_CAMERA_LAYOUT);
  });
});
