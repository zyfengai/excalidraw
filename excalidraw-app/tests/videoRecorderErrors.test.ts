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

    const lowercaseNotSupportedError = new Error("");
    lowercaseNotSupportedError.name = "notsupportederror";
    expect(mapVideoRecorderErrorMessage(lowercaseNotSupportedError)).toBe(
      "This browser does not support video recording.",
    );

    const paddedNotFoundError = new Error("");
    paddedNotFoundError.name = " NotFoundError ";
    expect(mapVideoRecorderErrorMessage(paddedNotFoundError)).toBe(
      "Selected camera or microphone is not available.",
    );
  });

  it("maps nested cause and reason payloads", () => {
    expect(
      mapVideoRecorderErrorMessage({
        cause: { name: "NotFoundError" },
      }),
    ).toBe("Selected camera or microphone is not available.");
    expect(
      mapVideoRecorderErrorMessage({
        cause: { message: "Permission denied while accessing media input." },
      }),
    ).toBe("Camera or microphone permission was denied.");
    expect(
      mapVideoRecorderErrorMessage({
        reason: "No such device",
      }),
    ).toBe("Selected camera or microphone is not available.");
    expect(
      mapVideoRecorderErrorMessage({
        cause: "NotSupportedError",
      }),
    ).toBe("This browser does not support video recording.");
    expect(
      mapVideoRecorderErrorMessage({
        cause: "Permission denied while accessing media input.",
      }),
    ).toBe("Camera or microphone permission was denied.");
    expect(
      mapVideoRecorderErrorMessage({
        error: { name: "NotSupportedError" },
      }),
    ).toBe("This browser does not support video recording.");
    expect(
      mapVideoRecorderErrorMessage({
        error: { message: "No such device" },
      }),
    ).toBe("Selected camera or microphone is not available.");
    expect(
      mapVideoRecorderErrorMessage({
        innerError: { name: "NotSupportedError" },
      }),
    ).toBe("This browser does not support video recording.");
    expect(
      mapVideoRecorderErrorMessage({
        originalError: { message: "No such device" },
      }),
    ).toBe("Selected camera or microphone is not available.");
    expect(
      mapVideoRecorderErrorMessage({
        name: "Error",
        cause: { name: "NotSupportedError" },
      }),
    ).toBe("This browser does not support video recording.");
    expect(
      mapVideoRecorderErrorMessage({
        name: "DOMException",
        cause: { name: "NotSupportedError" },
      }),
    ).toBe("This browser does not support video recording.");
    expect(
      mapVideoRecorderErrorMessage({
        name: "AggregateError",
        errors: [{ name: "NotSupportedError" }],
      }),
    ).toBe("This browser does not support video recording.");
    expect(
      mapVideoRecorderErrorMessage({
        name: "Error",
        cause: {
          name: "DOMException",
          cause: {
            name: "AggregateError",
            errors: [{ cause: { name: "NotSupportedError" } }],
          },
        },
      }),
    ).toBe("This browser does not support video recording.");
    expect(
      mapVideoRecorderErrorMessage({
        name: "AggregateError",
        causes: [{ name: "NotSupportedError" }],
      }),
    ).toBe("This browser does not support video recording.");
    expect(
      mapVideoRecorderErrorMessage({
        reasons: ["No such device"],
      }),
    ).toBe("Selected camera or microphone is not available.");
    expect(
      mapVideoRecorderErrorMessage({
        err: { name: "NotSupportedError" },
      }),
    ).toBe("This browser does not support video recording.");
    expect(
      mapVideoRecorderErrorMessage({
        exception: { message: "No such device" },
      }),
    ).toBe("Selected camera or microphone is not available.");
  });

  it("maps media not-supported messages without explicit error names", () => {
    expect(
      mapVideoRecorderErrorMessage(
        new Error("MediaRecorder is not supported in this browser."),
      ),
    ).toBe("This browser does not support video recording.");
    expect(
      mapVideoRecorderErrorMessage(
        new Error(
          "The MIME type provided is not supported by this user agent.",
        ),
      ),
    ).toBe("This browser does not support video recording.");
  });

  it("maps legacy browser alias error names", () => {
    const permissionDeniedError = new Error("");
    permissionDeniedError.name = "PermissionDeniedError";
    expect(mapVideoRecorderErrorMessage(permissionDeniedError)).toBe(
      "Camera or microphone permission was denied.",
    );
    const permissionDismissedError = new Error("");
    permissionDismissedError.name = "PermissionDismissedError";
    expect(mapVideoRecorderErrorMessage(permissionDismissedError)).toBe(
      "Camera or microphone permission was denied.",
    );

    const constraintError = new Error("");
    constraintError.name = "ConstraintNotSatisfiedError";
    expect(mapVideoRecorderErrorMessage(constraintError)).toBe(
      "Selected camera or microphone is not available.",
    );

    const trackStartError = new Error("");
    trackStartError.name = "TrackStartError";
    expect(mapVideoRecorderErrorMessage(trackStartError)).toBe(
      "Camera or microphone is currently busy.",
    );
    const sourceUnavailableError = new Error("");
    sourceUnavailableError.name = "SourceUnavailableError";
    expect(mapVideoRecorderErrorMessage(sourceUnavailableError)).toBe(
      "Camera or microphone is currently busy.",
    );
  });

  it("maps known error message signals even without matching names", () => {
    expect(
      mapVideoRecorderErrorMessage(
        new Error("Permission denied while accessing media input."),
      ),
    ).toBe("Camera or microphone permission was denied.");
    expect(
      mapVideoRecorderErrorMessage(
        new Error("Requested device not found for selected input."),
      ),
    ).toBe("Selected camera or microphone is not available.");
    expect(
      mapVideoRecorderErrorMessage(
        new Error("Could not start video source due to another process."),
      ),
    ).toBe("Camera or microphone is currently busy.");
    expect(
      mapVideoRecorderErrorMessage(
        new Error("Could not start audio source due to another process."),
      ),
    ).toBe("Camera or microphone is currently busy.");
    expect(
      mapVideoRecorderErrorMessage(
        new Error("Could not start source because it is in use."),
      ),
    ).toBe("Camera or microphone is currently busy.");
    expect(
      mapVideoRecorderErrorMessage(
        new Error("Microphone is already in use by another application."),
      ),
    ).toBe("Camera or microphone is currently busy.");
    expect(
      mapVideoRecorderErrorMessage(
        new Error("Device or resource busy while opening media input."),
      ),
    ).toBe("Camera or microphone is currently busy.");
    expect(
      mapVideoRecorderErrorMessage(
        "Could not start audio source due to another process.",
      ),
    ).toBe("Camera or microphone is currently busy.");
    expect(
      mapVideoRecorderErrorMessage(
        "Failed to construct 'MediaRecorder': The type provided is not supported.",
      ),
    ).toBe("This browser does not support video recording.");
    expect(
      mapVideoRecorderErrorMessage(
        "Failed to construct 'MediaRecorder': Media Recorder is not supported in this browser.",
      ),
    ).toBe("This browser does not support video recording.");
    expect(
      mapVideoRecorderErrorMessage(
        "Media Recorder API is unavailable in this browser.",
      ),
    ).toBe("This browser does not support video recording.");
    expect(
      mapVideoRecorderErrorMessage("DOMException: NotSupportedError"),
    ).toBe("This browser does not support video recording.");
    expect(
      mapVideoRecorderErrorMessage(
        "Permission denied while accessing media input.",
      ),
    ).toBe("Camera or microphone permission was denied.");
    expect(
      mapVideoRecorderErrorMessage("Permission has been denied by the system."),
    ).toBe("Camera or microphone permission was denied.");
    expect(
      mapVideoRecorderErrorMessage(
        "Access denied while opening camera stream.",
      ),
    ).toBe("Camera or microphone permission was denied.");
    expect(
      mapVideoRecorderErrorMessage(
        "Microphone access has been blocked by browser settings.",
      ),
    ).toBe("Camera or microphone permission was denied.");
    expect(
      mapVideoRecorderErrorMessage(
        "The request is not allowed by the user agent or the platform in the current context.",
      ),
    ).toBe("Camera or microphone permission was denied.");
    expect(
      mapVideoRecorderErrorMessage("Camera permission was dismissed by user."),
    ).toBe("Camera or microphone permission was denied.");
    expect(
      mapVideoRecorderErrorMessage(
        "Requested device not found for selected input.",
      ),
    ).toBe("Selected camera or microphone is not available.");
    expect(mapVideoRecorderErrorMessage("No such device")).toBe(
      "Selected camera or microphone is not available.",
    );
    expect(
      mapVideoRecorderErrorMessage("Device ID invalid for selected input."),
    ).toBe("Selected camera or microphone is not available.");
    expect(
      mapVideoRecorderErrorMessage(
        "Failed to satisfy constraints specified for selected device.",
      ),
    ).toBe("Selected camera or microphone is not available.");
    expect(
      mapVideoRecorderErrorMessage(
        "Could not satisfy constraints for selected device.",
      ),
    ).toBe("Selected camera or microphone is not available.");
    expect(
      mapVideoRecorderErrorMessage(
        "Could not be satisfied constraints for selected device.",
      ),
    ).toBe("Selected camera or microphone is not available.");
    expect(mapVideoRecorderErrorMessage("NotSupportedError")).toBe(
      "This browser does not support video recording.",
    );
    expect(
      mapVideoRecorderErrorMessage("NotSupportedError: codec mismatch"),
    ).toBe("This browser does not support video recording.");
    expect(mapVideoRecorderErrorMessage("DOMException: SecurityError")).toBe(
      "Camera or microphone permission was denied.",
    );
    expect(mapVideoRecorderErrorMessage(" NotFoundError ")).toBe(
      "Selected camera or microphone is not available.",
    );
    expect(
      mapVideoRecorderErrorMessage("NotFoundError: selected input missing"),
    ).toBe("Selected camera or microphone is not available.");
    expect(mapVideoRecorderErrorMessage("TrackStartError")).toBe(
      "Camera or microphone is currently busy.",
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
    expect(mapVideoRecorderErrorMessage(new Error("   "))).toBe(
      "Recording failed. Please try again.",
    );
    expect(mapVideoRecorderErrorMessage("oops")).toBe(
      "Recording failed. Please try again.",
    );
    expect(
      mapVideoRecorderErrorMessage({
        message: "runtime disconnected",
      }),
    ).toBe("runtime disconnected");
  });
});
