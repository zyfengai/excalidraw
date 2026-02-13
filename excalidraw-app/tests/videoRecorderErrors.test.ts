import { describe, expect, it } from "vitest";

import { mapVideoRecorderErrorMessage } from "../components/video-recorder/useVideoRecorder";

describe("video recorder error mapping", () => {
  it("maps permission-related DOMException names", () => {
    expect(
      mapVideoRecorderErrorMessage(new DOMException("", "NotAllowedError")),
    ).toBe("Camera or microphone permission was denied.");
    expect(
      mapVideoRecorderErrorMessage(new DOMException("", "SecurityError")),
    ).toBe("Camera or microphone permission was denied.");
    expect(
      mapVideoRecorderErrorMessage(new DOMException("", "NotSupportedError")),
    ).toBe("This browser does not support video recording.");
  });

  it("maps missing device DOMException names", () => {
    expect(
      mapVideoRecorderErrorMessage(new DOMException("", "NotFoundError")),
    ).toBe("Selected camera or microphone is not available.");
    expect(
      mapVideoRecorderErrorMessage(
        new DOMException("", "OverconstrainedError"),
      ),
    ).toBe("Selected camera or microphone is not available.");
  });

  it("maps known error names even when not DOMException", () => {
    const notSupportedError = new Error("");
    notSupportedError.name = "NotSupportedError";
    expect(mapVideoRecorderErrorMessage(notSupportedError)).toBe(
      "This browser does not support video recording.",
    );

    const deviceNotFoundError = new Error("");
    deviceNotFoundError.name = "NotFoundError";
    expect(mapVideoRecorderErrorMessage(deviceNotFoundError)).toBe(
      "Selected camera or microphone is not available.",
    );
  });

  it("maps busy-device DOMException names", () => {
    expect(
      mapVideoRecorderErrorMessage(new DOMException("", "NotReadableError")),
    ).toBe("Camera or microphone is currently busy.");
    expect(
      mapVideoRecorderErrorMessage(new DOMException("", "AbortError")),
    ).toBe("Camera or microphone is currently busy.");
  });

  it("falls back to generic message", () => {
    expect(
      mapVideoRecorderErrorMessage(new DOMException("", "UnknownError")),
    ).toBe("Recording failed. Please try again.");
    expect(
      mapVideoRecorderErrorMessage(
        new DOMException("device disconnected", "UnknownError"),
      ),
    ).toBe("device disconnected");

    expect(mapVideoRecorderErrorMessage(new Error("custom failure"))).toBe(
      "custom failure",
    );
    expect(mapVideoRecorderErrorMessage("oops")).toBe(
      "Recording failed. Please try again.",
    );
  });
});
