import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EVENT } from "@excalidraw/common";
import { t } from "@excalidraw/excalidraw/i18n";

import {
  getDefaultVideoRecorderSettings,
  getVideoRecorderCapabilities,
} from "./videoRecorder.config";
import {
  loadVideoRecorderSettings,
  saveVideoRecorderSettings,
} from "./videoRecorder.storage";
import {
  clamp,
  clampOverlayLayout,
  getFileExtensionFromMimeType,
  getPermissionRequestConstraints,
  getVideoDimensions,
  normalizeRecorderAspectRatio,
  normalizeRecorderMimeType,
  normalizeRecorderFps,
  normalizeRecorderResolution,
  normalizedRectToPixels,
} from "./videoRecorder.utils";

import type {
  VideoRecorderCapabilities,
  VideoRecorderDeviceOption,
  VideoRecorderOverlayLayout,
  VideoRecorderResult,
  VideoRecorderSettings,
  VideoRecorderStatus,
} from "./videoRecorder.types";

const MEDIA_RECORDER_TIMESLICE_MS = 1000;
const STOP_RECORDING_TIMEOUT_MS = 3000;
const INVALID_FILE_NAME_CHARS = /[\\/:*?"<>|]/g;
const MAX_RECORDING_FILE_NAME_LENGTH = 120;
const TRAILING_RECORDING_FILE_EXTENSION = /(?:\.(?:webm|mp4))+$/i;
const WINDOWS_RESERVED_FILE_NAME =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

class StartRecordingCancelledError extends Error {}

const DEVICE_SELECTION_ERROR_NAMES = new Set([
  "notfounderror",
  "overconstrainederror",
  "constraintnotsatisfiederror",
  "devicesnotfounderror",
]);
const PERMISSION_DENIED_ERROR_NAMES = new Set([
  "notallowederror",
  "securityerror",
  "permissiondeniederror",
  "permissiondismissederror",
]);
const DEVICE_BUSY_ERROR_NAMES = new Set([
  "notreadableerror",
  "aborterror",
  "trackstarterror",
  "sourceunavailableerror",
]);
const GENERIC_ERROR_NAMES = new Set([
  "error",
  "exception",
  "domexception",
  "mediaerror",
  "aggregateerror",
]);
const ERROR_NAME_PREFIX_REGEX = /^([a-z][a-z0-9]*error)\b/i;
const ERROR_NAME_ANYWHERE_REGEX = /\b([a-z][a-z0-9]*error)\b/i;

const getErrorNameFromString = (value: string) => {
  const trimmedValue = value.trim();
  const prefixMatch = trimmedValue.match(ERROR_NAME_PREFIX_REGEX);
  if (prefixMatch?.[1]) {
    return prefixMatch[1];
  }
  const anywhereMatch = trimmedValue.match(ERROR_NAME_ANYWHERE_REGEX);
  return anywhereMatch?.[1] || trimmedValue;
};

const MAX_ERROR_CAUSE_TRAVERSAL_DEPTH = 5;

const isGenericErrorName = (value: string) =>
  GENERIC_ERROR_NAMES.has(value.trim().toLowerCase());

const hasNestedErrorCandidate = (value: unknown) => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const nestedTargetPayload = value as {
    target?: {
      error?: unknown;
      reason?: unknown;
      detail?: unknown;
      details?: unknown;
      data?: unknown;
      payload?: unknown;
    } | null;
    currentTarget?: {
      error?: unknown;
      reason?: unknown;
      detail?: unknown;
      details?: unknown;
      data?: unknown;
      payload?: unknown;
    } | null;
    srcElement?: {
      error?: unknown;
      reason?: unknown;
      detail?: unknown;
      details?: unknown;
      data?: unknown;
      payload?: unknown;
    } | null;
  };
  const hasNestedEventTargetPayload =
    nestedTargetPayload.target?.error !== undefined ||
    nestedTargetPayload.target?.reason !== undefined ||
    nestedTargetPayload.target?.detail !== undefined ||
    nestedTargetPayload.target?.details !== undefined ||
    nestedTargetPayload.target?.data !== undefined ||
    nestedTargetPayload.target?.payload !== undefined ||
    nestedTargetPayload.currentTarget?.error !== undefined ||
    nestedTargetPayload.currentTarget?.reason !== undefined ||
    nestedTargetPayload.currentTarget?.detail !== undefined ||
    nestedTargetPayload.currentTarget?.details !== undefined ||
    nestedTargetPayload.currentTarget?.data !== undefined ||
    nestedTargetPayload.currentTarget?.payload !== undefined ||
    nestedTargetPayload.srcElement?.error !== undefined ||
    nestedTargetPayload.srcElement?.reason !== undefined ||
    nestedTargetPayload.srcElement?.detail !== undefined ||
    nestedTargetPayload.srcElement?.details !== undefined ||
    nestedTargetPayload.srcElement?.data !== undefined ||
    nestedTargetPayload.srcElement?.payload !== undefined;

  return (
    hasNestedEventTargetPayload ||
    ("cause" in value && (value as { cause?: unknown }).cause !== undefined) ||
    ("error" in value && (value as { error?: unknown }).error !== undefined) ||
    ("err" in value && (value as { err?: unknown }).err !== undefined) ||
    ("exception" in value &&
      (value as { exception?: unknown }).exception !== undefined) ||
    ("innerError" in value &&
      (value as { innerError?: unknown }).innerError !== undefined) ||
    ("originalError" in value &&
      (value as { originalError?: unknown }).originalError !== undefined) ||
    ("rootCause" in value &&
      (value as { rootCause?: unknown }).rootCause !== undefined) ||
    ("underlyingError" in value &&
      (value as { underlyingError?: unknown }).underlyingError !== undefined) ||
    ("errors" in value &&
      Array.isArray((value as { errors?: unknown }).errors)) ||
    ("causes" in value &&
      Array.isArray((value as { causes?: unknown }).causes)) ||
    ("reasons" in value &&
      Array.isArray((value as { reasons?: unknown }).reasons)) ||
    ("reason" in value &&
      (value as { reason?: unknown }).reason !== undefined) ||
    ("payload" in value &&
      (value as { payload?: unknown }).payload !== undefined) ||
    ("detail" in value &&
      (value as { detail?: unknown }).detail !== undefined) ||
    ("details" in value &&
      (value as { details?: unknown }).details !== undefined) ||
    ("data" in value && (value as { data?: unknown }).data !== undefined)
  );
};

const isSemanticErrorEntry = (value: unknown) => {
  if (typeof value === "string") {
    const trimmedValue = value.trim();
    if (!trimmedValue) {
      return false;
    }
    const extractedName = getErrorNameFromString(trimmedValue);
    return !isGenericErrorName(extractedName);
  }
  if (!value || typeof value !== "object") {
    return false;
  }

  if ("message" in value && typeof value.message === "string") {
    return value.message.trim().length > 0;
  }
  if ("reason" in value && typeof value.reason === "string") {
    return value.reason.trim().length > 0;
  }
  if ("name" in value && typeof value.name === "string") {
    const normalizedName = value.name.trim();
    if (normalizedName && !isGenericErrorName(normalizedName)) {
      return true;
    }
  }

  return hasNestedErrorCandidate(value);
};

const getFirstArrayEntry = (value: unknown) => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  let firstNonNullishEntry: unknown = undefined;
  for (const entry of value) {
    if (entry !== undefined && entry !== null) {
      if (firstNonNullishEntry === undefined) {
        firstNonNullishEntry = entry;
      }
      if (isSemanticErrorEntry(entry)) {
        return entry;
      }
    }
  }
  return firstNonNullishEntry;
};

const getErrorPathPayload = (value: unknown) => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const directPathEntry = getFirstArrayEntry(
    (value as { path?: unknown }).path,
  );
  if (directPathEntry !== undefined && isSemanticErrorEntry(directPathEntry)) {
    return directPathEntry;
  }

  if (!("composedPath" in value)) {
    return undefined;
  }

  const composedPathCandidate = (value as { composedPath?: unknown })
    .composedPath;
  if (typeof composedPathCandidate !== "function") {
    return undefined;
  }

  let composedPathEntries: unknown;
  try {
    composedPathEntries = composedPathCandidate.call(value);
  } catch {
    return undefined;
  }

  const composedPathEntry = getFirstArrayEntry(composedPathEntries);
  if (
    composedPathEntry !== undefined &&
    isSemanticErrorEntry(composedPathEntry)
  ) {
    return composedPathEntry;
  }

  return undefined;
};

const getNextNestedError = (error: unknown) => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const nestedEventPayload = error as {
    target?: {
      error?: unknown;
      reason?: unknown;
      detail?: unknown;
      details?: unknown;
      data?: unknown;
      payload?: unknown;
    } | null;
    currentTarget?: {
      error?: unknown;
      reason?: unknown;
      detail?: unknown;
      details?: unknown;
      data?: unknown;
      payload?: unknown;
    } | null;
    srcElement?: {
      error?: unknown;
      reason?: unknown;
      detail?: unknown;
      details?: unknown;
      data?: unknown;
      payload?: unknown;
    } | null;
  };
  const nestedEventTargetError =
    nestedEventPayload.target?.error ??
    nestedEventPayload.currentTarget?.error ??
    nestedEventPayload.srcElement?.error ??
    nestedEventPayload.target?.reason ??
    nestedEventPayload.currentTarget?.reason ??
    nestedEventPayload.srcElement?.reason ??
    nestedEventPayload.target?.payload ??
    nestedEventPayload.currentTarget?.payload ??
    nestedEventPayload.srcElement?.payload ??
    nestedEventPayload.target?.detail ??
    nestedEventPayload.currentTarget?.detail ??
    nestedEventPayload.srcElement?.detail ??
    nestedEventPayload.target?.details ??
    nestedEventPayload.currentTarget?.details ??
    nestedEventPayload.srcElement?.details ??
    nestedEventPayload.target?.data ??
    nestedEventPayload.currentTarget?.data ??
    nestedEventPayload.srcElement?.data;
  if (nestedEventTargetError !== undefined) {
    return nestedEventTargetError;
  }

  const pathError = getErrorPathPayload(error);
  if (pathError !== undefined) {
    return pathError;
  }

  if ("cause" in error && (error as { cause?: unknown }).cause !== undefined) {
    return (error as { cause?: unknown }).cause;
  }

  if ("error" in error && (error as { error?: unknown }).error !== undefined) {
    return (error as { error?: unknown }).error;
  }

  if ("err" in error && (error as { err?: unknown }).err !== undefined) {
    return (error as { err?: unknown }).err;
  }

  if (
    "exception" in error &&
    (error as { exception?: unknown }).exception !== undefined
  ) {
    return (error as { exception?: unknown }).exception;
  }

  if (
    "innerError" in error &&
    (error as { innerError?: unknown }).innerError !== undefined
  ) {
    return (error as { innerError?: unknown }).innerError;
  }

  if (
    "originalError" in error &&
    (error as { originalError?: unknown }).originalError !== undefined
  ) {
    return (error as { originalError?: unknown }).originalError;
  }

  if (
    "rootCause" in error &&
    (error as { rootCause?: unknown }).rootCause !== undefined
  ) {
    return (error as { rootCause?: unknown }).rootCause;
  }

  if (
    "underlyingError" in error &&
    (error as { underlyingError?: unknown }).underlyingError !== undefined
  ) {
    return (error as { underlyingError?: unknown }).underlyingError;
  }

  if (
    "reason" in error &&
    (error as { reason?: unknown }).reason !== undefined
  ) {
    return (error as { reason?: unknown }).reason;
  }

  if (
    "payload" in error &&
    (error as { payload?: unknown }).payload !== undefined
  ) {
    const payload = (error as { payload?: unknown }).payload;
    if (payload && typeof payload === "object" && "error" in payload) {
      return (payload as { error?: unknown }).error ?? payload;
    }
    return payload;
  }

  if ("errors" in error) {
    const firstNestedError = getFirstArrayEntry(
      (error as { errors?: unknown }).errors,
    );
    if (firstNestedError !== undefined) {
      return firstNestedError;
    }
  }

  if ("causes" in error) {
    const firstNestedCause = getFirstArrayEntry(
      (error as { causes?: unknown }).causes,
    );
    if (firstNestedCause !== undefined) {
      return firstNestedCause;
    }
  }

  if ("reasons" in error) {
    const firstNestedReason = getFirstArrayEntry(
      (error as { reasons?: unknown }).reasons,
    );
    if (firstNestedReason !== undefined) {
      return firstNestedReason;
    }
  }

  if (
    "detail" in error &&
    (error as { detail?: unknown }).detail !== undefined
  ) {
    const detail = (error as { detail?: unknown }).detail;
    if (
      detail &&
      typeof detail === "object" &&
      "error" in detail &&
      (detail as { error?: unknown }).error !== undefined
    ) {
      return (detail as { error?: unknown }).error;
    }
    return detail;
  }

  if (
    "details" in error &&
    (error as { details?: unknown }).details !== undefined
  ) {
    const details = (error as { details?: unknown }).details;
    if (
      details &&
      typeof details === "object" &&
      "error" in details &&
      (details as { error?: unknown }).error !== undefined
    ) {
      return (details as { error?: unknown }).error;
    }
    return details;
  }

  if ("data" in error && (error as { data?: unknown }).data !== undefined) {
    const data = (error as { data?: unknown }).data;
    if (
      data &&
      typeof data === "object" &&
      "error" in data &&
      (data as { error?: unknown }).error !== undefined
    ) {
      return (data as { error?: unknown }).error;
    }
    return data;
  }

  return undefined;
};

const getErrorName = (error: unknown) => {
  if (typeof error === "string") {
    return getErrorNameFromString(error);
  }

  const visited = new Set<unknown>();
  let currentError: unknown = error;

  for (let depth = 0; depth < MAX_ERROR_CAUSE_TRAVERSAL_DEPTH; depth++) {
    if (typeof currentError === "string") {
      return getErrorNameFromString(currentError);
    }
    if (!currentError || typeof currentError !== "object") {
      return "";
    }
    if (visited.has(currentError)) {
      return "";
    }
    visited.add(currentError);

    if ("name" in currentError && typeof currentError.name === "string") {
      const normalizedErrorName = currentError.name.trim();
      if (normalizedErrorName && !isGenericErrorName(normalizedErrorName)) {
        return currentError.name;
      }
    }

    const nextError = getNextNestedError(currentError);
    if (nextError === undefined) {
      return "";
    }
    currentError = nextError;
  }

  return "";
};

const getNormalizedErrorName = (error: unknown) =>
  getErrorName(error).trim().toLowerCase();

const getErrorMessage = (error: unknown) => {
  if (typeof error === "string") {
    return error;
  }

  const visited = new Set<unknown>();
  let currentError: unknown = error;

  for (let depth = 0; depth < MAX_ERROR_CAUSE_TRAVERSAL_DEPTH; depth++) {
    if (typeof currentError === "string") {
      return currentError;
    }
    if (!currentError || typeof currentError !== "object") {
      return "";
    }
    if (visited.has(currentError)) {
      return "";
    }
    visited.add(currentError);

    if ("message" in currentError && typeof currentError.message === "string") {
      return currentError.message;
    }
    if ("reason" in currentError && typeof currentError.reason === "string") {
      return currentError.reason;
    }

    const nextError = getNextNestedError(currentError);
    if (nextError === undefined) {
      return "";
    }
    currentError = nextError;
  }

  return "";
};

const getNormalizedErrorMessage = (error: unknown) =>
  getErrorMessage(error).trim().toLowerCase();

const isPermissionDeniedError = (error: unknown) => {
  if (PERMISSION_DENIED_ERROR_NAMES.has(getNormalizedErrorName(error))) {
    return true;
  }
  const message = getNormalizedErrorMessage(error);
  if (!message) {
    return false;
  }
  const hasPermissionDeniedSignal =
    message.includes("permission denied") ||
    (message.includes("permission") && message.includes("denied"));
  const hasPermissionBlockedSignal =
    message.includes("blocked") &&
    (message.includes("permission") ||
      message.includes("access") ||
      message.includes("camera") ||
      message.includes("microphone"));
  const hasPermissionDismissedSignal =
    message.includes("permission") && message.includes("dismissed");
  const hasRequestNotAllowedSignal =
    message.includes("not allowed by the user agent") ||
    ((message.includes("request") || message.includes("operation")) &&
      message.includes("not allowed") &&
      (message.includes("user agent") ||
        message.includes("platform") ||
        message.includes("current context")));
  const hasPermissionsPolicySignal =
    message.includes("permissions policy") &&
    (message.includes("disallow") ||
      message.includes("denied") ||
      message.includes("blocked") ||
      message.includes("not allowed"));
  const hasSecureContextSignal =
    (message.includes("only secure origins are allowed") ||
      message.includes("secure context") ||
      message.includes("secure origin")) &&
    (message.includes("camera") ||
      message.includes("microphone") ||
      message.includes("mediadevices") ||
      message.includes("getusermedia"));
  return (
    hasPermissionDeniedSignal ||
    hasPermissionBlockedSignal ||
    hasPermissionDismissedSignal ||
    hasRequestNotAllowedSignal ||
    hasPermissionsPolicySignal ||
    hasSecureContextSignal ||
    message.includes("access denied") ||
    message.includes("permissiondismissederror") ||
    message.includes("notallowederror")
  );
};

const isDeviceSelectionError = (error: unknown) => {
  if (DEVICE_SELECTION_ERROR_NAMES.has(getNormalizedErrorName(error))) {
    return true;
  }

  const message = getNormalizedErrorMessage(error);
  if (!message) {
    return false;
  }

  const hasNoSuchDeviceSignal =
    message.includes("no such device") ||
    (message.includes("device id") &&
      (message.includes("not found") || message.includes("invalid")));
  const hasNotFoundSignal =
    message.includes("notfounderror") ||
    hasNoSuchDeviceSignal ||
    ((message.includes("device") || message.includes("input")) &&
      (message.includes("not found") ||
        message.includes("cannot find") ||
        message.includes("unavailable")));
  const hasCouldNotFindSignal =
    (message.includes("could not find") ||
      message.includes("unable to find")) &&
    (message.includes("device") ||
      message.includes("source") ||
      message.includes("input") ||
      message.includes("camera") ||
      message.includes("microphone"));
  const hasConstraintSignal =
    (message.includes("overconstrained") || message.includes("constraint")) &&
    (message.includes("not satisfied") ||
      message.includes("cannot be satisfied") ||
      message.includes("cannot satisfy") ||
      message.includes("could not be satisfied") ||
      message.includes("could not satisfy") ||
      message.includes("unable to satisfy") ||
      message.includes("could not be met") ||
      message.includes("unsatisfied") ||
      message.includes("constraint failed") ||
      message.includes("failed to satisfy"));

  return hasNotFoundSignal || hasCouldNotFindSignal || hasConstraintSignal;
};

const isDeviceBusyError = (error: unknown) => {
  if (DEVICE_BUSY_ERROR_NAMES.has(getNormalizedErrorName(error))) {
    return true;
  }

  const message = getNormalizedErrorMessage(error);
  if (!message) {
    return false;
  }

  const hasCouldNotStartSourceSignal =
    message.includes("could not start video source") ||
    message.includes("could not start audio source") ||
    (message.includes("could not start") && message.includes("source"));
  const hasDeviceInUseSignal =
    message.includes("already in use") ||
    (message.includes("in use") &&
      (message.includes("device") ||
        message.includes("camera") ||
        message.includes("microphone") ||
        message.includes("source")));
  const hasResourceBusySignal =
    message.includes("resource busy") || message.includes("busy or locked");
  const hasFailedAllocationSignal =
    message.includes("failed to allocate videosource") ||
    message.includes("failed to allocate video source") ||
    message.includes("failed to allocate audiosource") ||
    message.includes("failed to allocate audio source") ||
    (message.includes("failed to allocate") &&
      (message.includes("source") ||
        message.includes("camera") ||
        message.includes("microphone") ||
        message.includes("device")));

  return (
    message.includes("notreadableerror") ||
    message.includes("trackstarterror") ||
    message.includes("source unavailable") ||
    message.includes("device busy") ||
    hasCouldNotStartSourceSignal ||
    hasDeviceInUseSignal ||
    hasResourceBusySignal ||
    hasFailedAllocationSignal
  );
};

const isMimeNotSupportedMessage = (error: unknown) => {
  const message = getNormalizedErrorMessage(error);
  if (!message) {
    return false;
  }
  const hasUnavailableMediaRecorderSignal =
    (message.includes("unavailable") || message.includes("not available")) &&
    (message.includes("mediarecorder") || message.includes("media recorder"));
  const hasMissingMediaRecorderSignal =
    (message.includes("mediarecorder") || message.includes("media recorder")) &&
    (message.includes("is not defined") ||
      message.includes("undefined") ||
      message.includes("not implemented"));
  const hasInvalidConstructorSignal =
    (message.includes("mediarecorder") || message.includes("media recorder")) &&
    (message.includes("not a constructor") ||
      message.includes("illegal constructor"));
  const hasDisabledMediaRecorderSignal =
    (message.includes("mediarecorder") || message.includes("media recorder")) &&
    (message.includes("disabled") || message.includes("turned off"));
  if (
    hasUnavailableMediaRecorderSignal ||
    hasMissingMediaRecorderSignal ||
    hasInvalidConstructorSignal ||
    hasDisabledMediaRecorderSignal
  ) {
    return true;
  }
  const hasUnsupportedToken =
    message.includes("unsupported") ||
    message.includes("not supported") ||
    message.includes("cannot be used");
  if (!hasUnsupportedToken) {
    return false;
  }
  const hasMimeContext =
    message.includes("mime") ||
    message.includes("mediarecorder") ||
    message.includes("media recorder") ||
    message.includes("type provided") ||
    message.includes("video/") ||
    message.includes("audio/");
  return hasMimeContext;
};

const isNotSupportedError = (error: unknown) =>
  getNormalizedErrorName(error) === "notsupportederror" ||
  getNormalizedErrorMessage(error).includes("notsupportederror") ||
  isMimeNotSupportedMessage(error);

const isMimeRelatedTypeError = (error: unknown) => {
  if (!(error instanceof TypeError)) {
    return false;
  }

  const message = getNormalizedErrorMessage(error);
  if (!message) {
    return true;
  }

  return (
    message.includes("mediarecorder") ||
    message.includes("media recorder") ||
    message.includes("mime") ||
    message.includes("type provided") ||
    message.includes("unsupported") ||
    message.includes("not supported")
  );
};

const isRecoverableMediaRecorderMimeError = (error: unknown) =>
  isMimeRelatedTypeError(error) || isNotSupportedError(error);

const getUserMediaWithDeviceFallback = async (
  primaryConstraints: MediaStreamConstraints,
  fallbackConstraints?: MediaStreamConstraints,
  onFallbackFromSelectionError?: () => void,
) => {
  try {
    return await navigator.mediaDevices.getUserMedia(primaryConstraints);
  } catch (error) {
    if (!fallbackConstraints || !isDeviceSelectionError(error)) {
      throw error;
    }
    onFallbackFromSelectionError?.();
    return navigator.mediaDevices.getUserMedia(fallbackConstraints);
  }
};

const hasSpecificDeviceConstraint = (
  constraint: MediaTrackConstraints | boolean | undefined,
) => {
  if (!constraint || typeof constraint === "boolean") {
    return false;
  }

  const { deviceId } = constraint;
  if (!deviceId) {
    return false;
  }

  if (typeof deviceId === "string") {
    return deviceId.length > 0;
  }

  if (Array.isArray(deviceId)) {
    return deviceId.length > 0;
  }

  return "exact" in deviceId && !!deviceId.exact;
};

const reconcileSelectedDeviceId = (
  selectedDeviceId: string | null,
  availableDevices: VideoRecorderDeviceOption[],
  shouldPreserveWhenDeviceTypeMissing: boolean,
) => {
  if (!selectedDeviceId) {
    return selectedDeviceId;
  }

  if (availableDevices.length === 0) {
    return shouldPreserveWhenDeviceTypeMissing ? selectedDeviceId : null;
  }

  const exists = availableDevices.some(
    (device) => device.deviceId === selectedDeviceId,
  );
  return exists ? selectedDeviceId : null;
};

const stopMediaStreamsTracksOnce = (
  ...streams: Array<MediaStream | null | undefined>
) => {
  const tracksToStop = new Set<MediaStreamTrack>();
  streams.forEach((stream) => {
    stream?.getTracks().forEach((track) => tracksToStop.add(track));
  });
  tracksToStop.forEach((track) => {
    try {
      track.stop();
    } catch (trackStopError) {
      console.error(trackStopError);
    }
  });
};

const replaceControlCharacters = (value: string) =>
  Array.from(value, (char) => {
    const charCode = char.charCodeAt(0);
    return charCode <= 31 || charCode === 127 ? "-" : char;
  }).join("");

const areOverlayLayoutsEqual = (
  a: VideoRecorderOverlayLayout,
  b: VideoRecorderOverlayLayout,
) =>
  a.x === b.x &&
  a.y === b.y &&
  a.width === b.width &&
  a.height === b.height &&
  a.shape === b.shape;

const areVideoRecorderSettingsEqual = (
  a: VideoRecorderSettings,
  b: VideoRecorderSettings,
) =>
  a.cameraEnabled === b.cameraEnabled &&
  a.microphoneEnabled === b.microphoneEnabled &&
  a.selectedVideoDeviceId === b.selectedVideoDeviceId &&
  a.selectedAudioDeviceId === b.selectedAudioDeviceId &&
  a.aspectRatio === b.aspectRatio &&
  a.resolution === b.resolution &&
  a.fps === b.fps &&
  a.mimeType === b.mimeType &&
  a.teleprompter.enabled === b.teleprompter.enabled &&
  a.teleprompter.text === b.teleprompter.text &&
  a.teleprompter.opacity === b.teleprompter.opacity &&
  a.teleprompter.speed === b.teleprompter.speed &&
  areOverlayLayoutsEqual(a.camera, b.camera);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object";

const normalizeSelectedDeviceId = (value: unknown, fallback: string | null) => {
  if (typeof value === "string") {
    const trimmedValue = value.trim();
    return trimmedValue.length > 0 ? trimmedValue : null;
  }
  if (value === null) {
    return null;
  }
  return fallback;
};

const normalizeCameraShape = (
  value: unknown,
  fallback: VideoRecorderOverlayLayout["shape"],
) =>
  value === "rectangle" || value === "rounded" || value === "circle"
    ? value
    : fallback;

const normalizeOverlayLayoutInput = (
  value: unknown,
  fallback: VideoRecorderOverlayLayout,
) => {
  const input = isObject(value) ? value : {};
  return clampOverlayLayout({
    x: isFiniteNumber(input.x) ? input.x : fallback.x,
    y: isFiniteNumber(input.y) ? input.y : fallback.y,
    width: isFiniteNumber(input.width) ? input.width : fallback.width,
    height: isFiniteNumber(input.height) ? input.height : fallback.height,
    shape: normalizeCameraShape(input.shape, fallback.shape),
  });
};

const normalizeTeleprompterInput = (
  value: unknown,
  fallback: VideoRecorderSettings["teleprompter"],
) => {
  const input = isObject(value) ? value : {};
  return {
    enabled:
      typeof input.enabled === "boolean" ? input.enabled : fallback.enabled,
    text: typeof input.text === "string" ? input.text : fallback.text,
    opacity: clamp(
      isFiniteNumber(input.opacity) ? input.opacity : fallback.opacity,
      0.05,
      1,
    ),
    speed: clamp(
      isFiniteNumber(input.speed) ? input.speed : fallback.speed,
      5,
      250,
    ),
  };
};

const normalizeBoolean = (value: unknown, fallback: boolean) =>
  typeof value === "boolean" ? value : fallback;

const normalizeString = (value: unknown, fallback: string) =>
  typeof value === "string" ? value : fallback;

const normalizeNumber = (value: unknown, fallback: number) =>
  isFiniteNumber(value) ? value : fallback;

const normalizeMimeTypeInput = (
  value: unknown,
  fallback: string,
  supportedMimeTypes: string[],
) => {
  const requestedMimeType = normalizeString(value, fallback).trim();
  const normalizedMimeType = normalizeRecorderMimeType(
    requestedMimeType,
    supportedMimeTypes,
  );
  if (normalizedMimeType) {
    return normalizedMimeType;
  }
  return requestedMimeType || fallback;
};

const normalizeSettingsInput = (
  value: unknown,
  fallback: VideoRecorderSettings,
  supportedMimeTypes: string[],
): VideoRecorderSettings => {
  const input = isObject(value) ? value : {};
  const cameraEnabled = normalizeBoolean(
    input.cameraEnabled,
    fallback.cameraEnabled,
  );
  const microphoneEnabled = normalizeBoolean(
    input.microphoneEnabled,
    fallback.microphoneEnabled,
  );
  const aspectRatio = normalizeRecorderAspectRatio(
    normalizeString(input.aspectRatio, fallback.aspectRatio),
    fallback.aspectRatio,
  );
  const resolution = normalizeRecorderResolution(
    normalizeString(input.resolution, fallback.resolution),
    fallback.resolution,
  );
  const fps = normalizeRecorderFps(
    normalizeNumber(input.fps, fallback.fps),
    fallback.fps,
  );
  const mimeType = normalizeMimeTypeInput(
    input.mimeType,
    fallback.mimeType,
    supportedMimeTypes,
  );
  const camera = normalizeOverlayLayoutInput(input.camera, fallback.camera);
  const teleprompter = normalizeTeleprompterInput(
    input.teleprompter,
    fallback.teleprompter,
  );

  return {
    cameraEnabled,
    microphoneEnabled,
    selectedVideoDeviceId: normalizeSelectedDeviceId(
      input.selectedVideoDeviceId,
      fallback.selectedVideoDeviceId,
    ),
    selectedAudioDeviceId: normalizeSelectedDeviceId(
      input.selectedAudioDeviceId,
      fallback.selectedAudioDeviceId,
    ),
    aspectRatio,
    resolution,
    fps,
    mimeType,
    camera,
    teleprompter,
  };
};

const areDeviceOptionListsEqual = (
  a: VideoRecorderDeviceOption[],
  b: VideoRecorderDeviceOption[],
) =>
  a.length === b.length &&
  a.every(
    (device, index) =>
      device.deviceId === b[index]?.deviceId &&
      device.label === b[index]?.label,
  );

const areDeviceCollectionsEqual = (
  a: {
    videoInputs: VideoRecorderDeviceOption[];
    audioInputs: VideoRecorderDeviceOption[];
  },
  b: {
    videoInputs: VideoRecorderDeviceOption[];
    audioInputs: VideoRecorderDeviceOption[];
  },
) =>
  areDeviceOptionListsEqual(a.videoInputs, b.videoInputs) &&
  areDeviceOptionListsEqual(a.audioInputs, b.audioInputs);

const getExcalidrawCanvases = () => {
  const staticCanvas = document.querySelector<HTMLCanvasElement>(
    ".excalidraw canvas.static",
  );
  const interactiveCanvas = document.querySelector<HTMLCanvasElement>(
    ".excalidraw canvas.interactive",
  );

  if (!staticCanvas || !interactiveCanvas) {
    throw new Error(t("videoRecorder.errors.canvasNotFound"));
  }

  return {
    staticCanvas,
    interactiveCanvas,
  };
};

const drawCanvasContain = (
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  targetWidth: number,
  targetHeight: number,
) => {
  const sourceWidth = source.width;
  const sourceHeight = source.height;

  if (!sourceWidth || !sourceHeight) {
    return;
  }

  const scale = Math.min(
    targetWidth / sourceWidth,
    targetHeight / sourceHeight,
  );
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const offsetX = (targetWidth - drawWidth) / 2;
  const offsetY = (targetHeight - drawHeight) / 2;

  context.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);
};

const applyRoundedClip = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  const clippedRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + clippedRadius, y);
  context.lineTo(x + width - clippedRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + clippedRadius);
  context.lineTo(x + width, y + height - clippedRadius);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - clippedRadius,
    y + height,
  );
  context.lineTo(x + clippedRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - clippedRadius);
  context.lineTo(x, y + clippedRadius);
  context.quadraticCurveTo(x, y, x + clippedRadius, y);
  context.closePath();
  context.clip();
};

const drawCameraOverlay = ({
  context,
  cameraVideo,
  targetWidth,
  targetHeight,
  layout,
}: {
  context: CanvasRenderingContext2D;
  cameraVideo: HTMLVideoElement;
  targetWidth: number;
  targetHeight: number;
  layout: VideoRecorderOverlayLayout;
}) => {
  if (
    !cameraVideo.videoWidth ||
    !cameraVideo.videoHeight ||
    cameraVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    return;
  }

  const { x, y, width, height } = normalizedRectToPixels(
    layout,
    targetWidth,
    targetHeight,
  );

  context.save();
  if (layout.shape === "circle") {
    const radius = Math.min(width, height) / 2;
    context.beginPath();
    context.arc(x + width / 2, y + height / 2, radius, 0, Math.PI * 2);
    context.clip();
  } else if (layout.shape === "rounded") {
    applyRoundedClip(context, x, y, width, height, Math.max(12, width * 0.1));
  }
  context.drawImage(cameraVideo, x, y, width, height);
  context.restore();
};

const collectUniqueDeviceOptions = (
  devices: MediaDeviceInfo[],
  kind: MediaDeviceKind,
  fallbackLabel: string,
) => {
  const labelsByDeviceId = new Map<string, string>();

  devices.forEach((device) => {
    if (device.kind !== kind) {
      return;
    }

    const deviceId = device.deviceId?.trim();
    if (!deviceId) {
      return;
    }

    const normalizedLabel = device.label?.trim() || "";
    const existingLabel = labelsByDeviceId.get(deviceId);
    if (existingLabel === undefined || (!existingLabel && normalizedLabel)) {
      labelsByDeviceId.set(deviceId, normalizedLabel);
    }
  });

  const deduplicatedDevices = Array.from(labelsByDeviceId.entries())
    .map(([deviceId, label]) => ({
      deviceId,
      label,
    }))
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));

  return deduplicatedDevices.map((device, idx) => ({
    deviceId: device.deviceId,
    label: device.label || `${fallbackLabel} ${idx + 1}`,
  }));
};

const collectMediaDevices = async () => {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return {
      videoInputs: [] as VideoRecorderDeviceOption[],
      audioInputs: [] as VideoRecorderDeviceOption[],
    };
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoInputs = collectUniqueDeviceOptions(
    devices,
    "videoinput",
    "Camera",
  );
  const audioInputs = collectUniqueDeviceOptions(
    devices,
    "audioinput",
    "Microphone",
  );

  return {
    videoInputs,
    audioInputs,
  };
};

export const mapVideoRecorderErrorMessage = (error: unknown) => {
  if (isPermissionDeniedError(error)) {
    return t("videoRecorder.errors.permissionDenied");
  }
  if (isNotSupportedError(error)) {
    return t("videoRecorder.errors.notSupported");
  }
  if (isDeviceSelectionError(error)) {
    return t("videoRecorder.errors.deviceNotFound");
  }
  if (isDeviceBusyError(error)) {
    return t("videoRecorder.errors.deviceBusy");
  }

  const errorMessage =
    error && typeof error === "object" ? getErrorMessage(error).trim() : "";
  if (errorMessage.length > 0) {
    return errorMessage;
  }
  return t("videoRecorder.errors.recordingFailed");
};

const getMediaRecorderRuntimeError = (event: unknown) => {
  if (!event || typeof event !== "object") {
    return event;
  }

  const getPathEntriesPayload = (pathEntries: unknown): unknown => {
    if (!Array.isArray(pathEntries)) {
      return undefined;
    }

    const extractedEntries: unknown[] = [];
    for (const entry of pathEntries) {
      const extractedEntry = getEventLikeErrorPayload(entry);
      if (extractedEntry !== undefined) {
        extractedEntries.push(extractedEntry);
      }
    }

    const semanticExtractedEntry = getFirstArrayEntry(extractedEntries);
    if (
      semanticExtractedEntry !== undefined &&
      isSemanticErrorEntry(semanticExtractedEntry)
    ) {
      return semanticExtractedEntry;
    }

    const semanticPathEntry = getFirstArrayEntry(pathEntries);
    if (
      semanticPathEntry !== undefined &&
      isSemanticErrorEntry(semanticPathEntry)
    ) {
      return semanticPathEntry;
    }

    return undefined;
  };

  const getComposedPathPayload = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || !("composedPath" in value)) {
      return undefined;
    }

    const composedPathCandidate = (value as { composedPath?: unknown })
      .composedPath;
    if (typeof composedPathCandidate !== "function") {
      return undefined;
    }

    let composedPathEntries: unknown;
    try {
      composedPathEntries = composedPathCandidate.call(value);
    } catch {
      return undefined;
    }

    return getPathEntriesPayload(composedPathEntries);
  };

  const getLegacyPathPayload = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || !("path" in value)) {
      return undefined;
    }

    const pathEntries = (value as { path?: unknown }).path;
    return getPathEntriesPayload(pathEntries);
  };

  const getEventLikeErrorPayload = (
    value: unknown,
    visited = new Set<unknown>(),
  ): unknown => {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    if (visited.has(value)) {
      return undefined;
    }
    visited.add(value);

    const getObjectErrorPayload = (candidate: unknown) => {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        !("error" in candidate)
      ) {
        return undefined;
      }
      return (candidate as { error?: unknown }).error;
    };

    const nestedEventPayload = value as {
      error?: unknown;
      reason?: unknown;
      detail?: unknown;
      details?: unknown;
      data?: unknown;
      payload?: unknown;
      nativeEvent?: unknown;
      originalEvent?: unknown;
      path?: unknown;
      target?: {
        error?: unknown;
        reason?: unknown;
        detail?: unknown;
        details?: unknown;
        data?: unknown;
        payload?: unknown;
      } | null;
      currentTarget?: {
        error?: unknown;
        reason?: unknown;
        detail?: unknown;
        details?: unknown;
        data?: unknown;
        payload?: unknown;
      } | null;
      srcElement?: {
        error?: unknown;
        reason?: unknown;
        detail?: unknown;
        details?: unknown;
        data?: unknown;
        payload?: unknown;
      } | null;
    };
    const nestedReasonError = getObjectErrorPayload(nestedEventPayload.reason);
    const nestedTargetReasonError =
      getObjectErrorPayload(nestedEventPayload.target?.reason) ??
      getObjectErrorPayload(nestedEventPayload.currentTarget?.reason) ??
      getObjectErrorPayload(nestedEventPayload.srcElement?.reason);
    const nestedPayloadError =
      getObjectErrorPayload(nestedEventPayload.payload) ??
      getObjectErrorPayload(nestedEventPayload.target?.payload) ??
      getObjectErrorPayload(nestedEventPayload.currentTarget?.payload) ??
      getObjectErrorPayload(nestedEventPayload.srcElement?.payload);
    const nestedDetailError =
      getObjectErrorPayload(nestedEventPayload.detail) ??
      getObjectErrorPayload(nestedEventPayload.target?.detail) ??
      getObjectErrorPayload(nestedEventPayload.currentTarget?.detail) ??
      getObjectErrorPayload(nestedEventPayload.srcElement?.detail);
    const nestedDetailsError =
      getObjectErrorPayload(nestedEventPayload.details) ??
      getObjectErrorPayload(nestedEventPayload.target?.details) ??
      getObjectErrorPayload(nestedEventPayload.currentTarget?.details) ??
      getObjectErrorPayload(nestedEventPayload.srcElement?.details);
    const nestedDataError =
      getObjectErrorPayload(nestedEventPayload.data) ??
      getObjectErrorPayload(nestedEventPayload.target?.data) ??
      getObjectErrorPayload(nestedEventPayload.currentTarget?.data) ??
      getObjectErrorPayload(nestedEventPayload.srcElement?.data);
    const nestedPathError = getPathEntriesPayload(nestedEventPayload.path);
    const nestedNativeEventError: unknown = getEventLikeErrorPayload(
      nestedEventPayload.nativeEvent,
      visited,
    );
    const nestedOriginalEventError: unknown = getEventLikeErrorPayload(
      nestedEventPayload.originalEvent,
      visited,
    );

    return (
      nestedEventPayload.error ??
      nestedEventPayload.target?.error ??
      nestedEventPayload.currentTarget?.error ??
      nestedEventPayload.srcElement?.error ??
      nestedReasonError ??
      nestedTargetReasonError ??
      nestedPayloadError ??
      nestedDetailError ??
      nestedDetailsError ??
      nestedDataError ??
      nestedPathError ??
      nestedNativeEventError ??
      nestedOriginalEventError ??
      nestedEventPayload.reason ??
      nestedEventPayload.target?.reason ??
      nestedEventPayload.currentTarget?.reason ??
      nestedEventPayload.srcElement?.reason ??
      nestedEventPayload.payload ??
      nestedEventPayload.target?.payload ??
      nestedEventPayload.currentTarget?.payload ??
      nestedEventPayload.srcElement?.payload ??
      nestedEventPayload.detail ??
      nestedEventPayload.target?.detail ??
      nestedEventPayload.currentTarget?.detail ??
      nestedEventPayload.srcElement?.detail ??
      nestedEventPayload.details ??
      nestedEventPayload.target?.details ??
      nestedEventPayload.currentTarget?.details ??
      nestedEventPayload.srcElement?.details ??
      nestedEventPayload.data ??
      nestedEventPayload.target?.data ??
      nestedEventPayload.currentTarget?.data ??
      nestedEventPayload.srcElement?.data ??
      nestedEventPayload.nativeEvent ??
      nestedEventPayload.originalEvent
    );
  };

  const getReasonErrorPayload = (value: unknown) => {
    if (!value || typeof value !== "object" || !("error" in value)) {
      return undefined;
    }
    return (value as { error?: unknown }).error;
  };

  const getPayloadErrorPayload = (value: unknown) => {
    if (!value || typeof value !== "object" || !("error" in value)) {
      return undefined;
    }
    return (value as { error?: unknown }).error;
  };

  const getDetailErrorPayload = (value: unknown) => {
    if (!value || typeof value !== "object" || !("error" in value)) {
      return undefined;
    }
    return (value as { error?: unknown }).error;
  };

  const getDetailsErrorPayload = (value: unknown) => {
    if (!value || typeof value !== "object" || !("error" in value)) {
      return undefined;
    }
    return (value as { error?: unknown }).error;
  };

  const getDataErrorPayload = (value: unknown) => {
    if (!value || typeof value !== "object" || !("error" in value)) {
      return undefined;
    }
    return (value as { error?: unknown }).error;
  };

  const eventPayload = event as {
    error?: unknown;
    target?: {
      error?: unknown;
      reason?: unknown;
      payload?: unknown;
      detail?: unknown;
      details?: unknown;
      data?: unknown;
    } | null;
    currentTarget?: {
      error?: unknown;
      reason?: unknown;
      payload?: unknown;
      detail?: unknown;
      details?: unknown;
      data?: unknown;
    } | null;
    srcElement?: {
      error?: unknown;
      reason?: unknown;
      payload?: unknown;
      detail?: unknown;
      details?: unknown;
      data?: unknown;
    } | null;
    reason?: unknown;
    detail?: unknown;
    details?: unknown;
    data?: unknown;
    payload?: unknown;
    nativeEvent?: unknown;
    originalEvent?: unknown;
    path?: unknown;
  };
  const reasonError =
    getReasonErrorPayload(eventPayload.reason) ??
    getReasonErrorPayload(eventPayload.target?.reason) ??
    getReasonErrorPayload(eventPayload.currentTarget?.reason) ??
    getReasonErrorPayload(eventPayload.srcElement?.reason);
  const payloadError =
    getPayloadErrorPayload(eventPayload.payload) ??
    getPayloadErrorPayload(eventPayload.target?.payload) ??
    getPayloadErrorPayload(eventPayload.currentTarget?.payload) ??
    getPayloadErrorPayload(eventPayload.srcElement?.payload);
  const detailError =
    getDetailErrorPayload(eventPayload.detail) ??
    getDetailErrorPayload(eventPayload.target?.detail) ??
    getDetailErrorPayload(eventPayload.currentTarget?.detail) ??
    getDetailErrorPayload(eventPayload.srcElement?.detail);
  const detailsError =
    getDetailsErrorPayload(eventPayload.details) ??
    getDetailsErrorPayload(eventPayload.target?.details) ??
    getDetailsErrorPayload(eventPayload.currentTarget?.details) ??
    getDetailsErrorPayload(eventPayload.srcElement?.details);
  const dataError =
    getDataErrorPayload(eventPayload.data) ??
    getDataErrorPayload(eventPayload.target?.data) ??
    getDataErrorPayload(eventPayload.currentTarget?.data) ??
    getDataErrorPayload(eventPayload.srcElement?.data);
  const composedPathError =
    getComposedPathPayload(event) ??
    getComposedPathPayload(eventPayload.nativeEvent) ??
    getComposedPathPayload(eventPayload.originalEvent);
  const legacyPathError =
    getLegacyPathPayload(event) ??
    getLegacyPathPayload(eventPayload.nativeEvent) ??
    getLegacyPathPayload(eventPayload.originalEvent);
  const directWrappedErrorPayload =
    getEventLikeErrorPayload(eventPayload.error) ??
    getEventLikeErrorPayload(eventPayload.target?.error) ??
    getEventLikeErrorPayload(eventPayload.currentTarget?.error) ??
    getEventLikeErrorPayload(eventPayload.srcElement?.error);
  const nativeEventError = getEventLikeErrorPayload(eventPayload.nativeEvent);
  const originalEventError = getEventLikeErrorPayload(
    eventPayload.originalEvent,
  );

  return (
    directWrappedErrorPayload ??
    eventPayload.error ??
    eventPayload.target?.error ??
    eventPayload.currentTarget?.error ??
    eventPayload.srcElement?.error ??
    reasonError ??
    payloadError ??
    eventPayload.target?.reason ??
    eventPayload.currentTarget?.reason ??
    eventPayload.srcElement?.reason ??
    eventPayload.target?.payload ??
    eventPayload.currentTarget?.payload ??
    eventPayload.srcElement?.payload ??
    eventPayload.target?.detail ??
    eventPayload.currentTarget?.detail ??
    eventPayload.srcElement?.detail ??
    eventPayload.target?.details ??
    eventPayload.currentTarget?.details ??
    eventPayload.srcElement?.details ??
    eventPayload.target?.data ??
    eventPayload.currentTarget?.data ??
    eventPayload.srcElement?.data ??
    detailError ??
    detailsError ??
    dataError ??
    composedPathError ??
    legacyPathError ??
    nativeEventError ??
    originalEventError ??
    eventPayload.reason ??
    eventPayload.payload ??
    eventPayload.detail ??
    eventPayload.details ??
    eventPayload.data ??
    eventPayload.path ??
    eventPayload.nativeEvent ??
    eventPayload.originalEvent ??
    event
  );
};

const sanitizeRecordingFileName = (name: string) => {
  const normalizedName = name
    .trim()
    .replace(TRAILING_RECORDING_FILE_EXTENSION, "");
  const normalizedWithoutInvalidChars = replaceControlCharacters(
    normalizedName.trim().replace(INVALID_FILE_NAME_CHARS, "-"),
  );

  const sanitized = normalizedWithoutInvalidChars
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^[-.\s]+|[-.\s]+$/g, "")
    .slice(0, MAX_RECORDING_FILE_NAME_LENGTH)
    .replace(/^[-.\s]+|[-.\s]+$/g, "");

  if (WINDOWS_RESERVED_FILE_NAME.test(sanitized)) {
    return "excalidraw-recording";
  }

  return sanitized || "excalidraw-recording";
};

type UseVideoRecorderReturn = {
  capabilities: VideoRecorderCapabilities;
  settings: VideoRecorderSettings;
  status: VideoRecorderStatus;
  error: string | null;
  isDialogOpen: boolean;
  elapsedMs: number;
  result: VideoRecorderResult | null;
  devices: {
    videoInputs: VideoRecorderDeviceOption[];
    audioInputs: VideoRecorderDeviceOption[];
  };
  isRecordingActive: boolean;
  isRequestingPermissions: boolean;
  setDialogOpen: (open: boolean) => void;
  setSettings: (
    next:
      | Partial<VideoRecorderSettings>
      | ((prev: VideoRecorderSettings) => VideoRecorderSettings),
  ) => void;
  updateCameraLayout: (
    next:
      | Partial<VideoRecorderOverlayLayout>
      | ((prev: VideoRecorderOverlayLayout) => VideoRecorderOverlayLayout),
  ) => void;
  refreshDevices: () => Promise<void>;
  requestMediaPermissions: () => Promise<void>;
  startRecording: () => Promise<void>;
  pauseRecording: () => void;
  resumeRecording: () => void;
  stopRecording: () => Promise<void>;
  resetResult: () => void;
  downloadRecording: (name: string) => void;
};

export const useVideoRecorder = (): UseVideoRecorderReturn => {
  const capabilities = useMemo(() => getVideoRecorderCapabilities(), []);

  const [settings, setSettingsState] = useState<VideoRecorderSettings>(() => {
    const defaults = getDefaultVideoRecorderSettings();
    const loaded = loadVideoRecorderSettings();
    const mimeType = normalizeMimeTypeInput(
      loaded.mimeType || defaults.mimeType || "",
      defaults.mimeType || "",
      capabilities.supportedMimeTypes,
    );

    return {
      ...defaults,
      ...loaded,
      mimeType,
    };
  });
  const [status, setStatus] = useState<VideoRecorderStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isDialogOpen, setDialogOpen] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState<VideoRecorderResult | null>(null);
  const [isRequestingPermissions, setIsRequestingPermissions] = useState(false);
  const [devices, setDevices] = useState<{
    videoInputs: VideoRecorderDeviceOption[];
    audioInputs: VideoRecorderDeviceOption[];
  }>({
    videoInputs: [],
    audioInputs: [],
  });

  const renderFrameRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const compositionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number | null>(null);
  const pausedAtRef = useRef<number | null>(null);
  const pausedAccumulatedRef = useRef<number>(0);
  const elapsedTimerRef = useRef<number | null>(null);
  const permissionRequestInFlightRef = useRef(false);
  const startRecordingInFlightRef = useRef(false);
  const startRecordingRequestIdRef = useRef(0);
  const refreshDevicesRequestIdRef = useRef(0);
  const stopRecordingInFlightRef = useRef(false);
  const stopRecordingTimeoutRef = useRef<number | null>(null);
  const stopRecordingFinalizeRef = useRef<(() => void) | null>(null);
  const isMountedRef = useRef(true);

  const clearElapsedTimer = useCallback(() => {
    if (elapsedTimerRef.current != null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }, []);

  const cleanupStreams = useCallback(() => {
    if (stopRecordingTimeoutRef.current != null) {
      window.clearTimeout(stopRecordingTimeoutRef.current);
      stopRecordingTimeoutRef.current = null;
    }

    if (stopRecordingFinalizeRef.current) {
      const finalizeStop = stopRecordingFinalizeRef.current;
      stopRecordingFinalizeRef.current = null;
      finalizeStop();
    }

    if (renderFrameRef.current != null) {
      cancelAnimationFrame(renderFrameRef.current);
      renderFrameRef.current = null;
    }

    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
    }

    stopMediaStreamsTracksOnce(
      recordingStreamRef.current,
      cameraStreamRef.current,
      microphoneStreamRef.current,
    );
    recordingStreamRef.current = null;
    cameraStreamRef.current = null;
    microphoneStreamRef.current = null;

    if (cameraVideoRef.current) {
      cameraVideoRef.current.pause();
      cameraVideoRef.current.srcObject = null;
      cameraVideoRef.current = null;
    }

    compositionCanvasRef.current = null;
    clearElapsedTimer();
    stopRecordingInFlightRef.current = false;
    startRecordingInFlightRef.current = false;
    permissionRequestInFlightRef.current = false;
    startRecordingRequestIdRef.current += 1;
  }, [clearElapsedTimer]);

  const refreshDevices = useCallback(async () => {
    const requestId = refreshDevicesRequestIdRef.current + 1;
    refreshDevicesRequestIdRef.current = requestId;

    try {
      const mediaDevices = await collectMediaDevices();
      if (
        !isMountedRef.current ||
        requestId !== refreshDevicesRequestIdRef.current
      ) {
        return;
      }
      setDevices((prev) =>
        areDeviceCollectionsEqual(prev, mediaDevices) ? prev : mediaDevices,
      );
      setSettingsState((prev) => {
        const hasVideoInputs = mediaDevices.videoInputs.length > 0;
        const hasAudioInputs = mediaDevices.audioInputs.length > 0;
        const selectedVideoDeviceId = reconcileSelectedDeviceId(
          prev.selectedVideoDeviceId,
          mediaDevices.videoInputs,
          !hasAudioInputs || !prev.cameraEnabled,
        );
        const selectedAudioDeviceId = reconcileSelectedDeviceId(
          prev.selectedAudioDeviceId,
          mediaDevices.audioInputs,
          !hasVideoInputs || !prev.microphoneEnabled,
        );

        if (
          selectedVideoDeviceId === prev.selectedVideoDeviceId &&
          selectedAudioDeviceId === prev.selectedAudioDeviceId
        ) {
          return prev;
        }

        return {
          ...prev,
          selectedVideoDeviceId,
          selectedAudioDeviceId,
        };
      });
    } catch (deviceError) {
      if (
        !isMountedRef.current ||
        requestId !== refreshDevicesRequestIdRef.current
      ) {
        return;
      }
      console.error(deviceError);
    }
  }, []);

  const requestMediaPermissions = useCallback(async () => {
    if (!isMountedRef.current) {
      return;
    }

    if (!capabilities.isSupported) {
      setError(t("videoRecorder.errors.notSupported"));
      return;
    }

    if (permissionRequestInFlightRef.current) {
      return;
    }
    if (startRecordingInFlightRef.current) {
      return;
    }
    if (
      status === "preparing" ||
      status === "recording" ||
      status === "paused" ||
      status === "stopping"
    ) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError(t("videoRecorder.errors.notSupported"));
      return;
    }

    setError(null);
    permissionRequestInFlightRef.current = true;
    setIsRequestingPermissions(true);
    try {
      const requestedVideoDeviceId = settings.selectedVideoDeviceId;
      const requestedAudioDeviceId = settings.selectedAudioDeviceId;
      const primaryConstraints = getPermissionRequestConstraints(settings);
      const shouldClearVideoSelection = hasSpecificDeviceConstraint(
        primaryConstraints.video,
      );
      const shouldClearAudioSelection = hasSpecificDeviceConstraint(
        primaryConstraints.audio,
      );
      const isDualSpecificSelectionRequest =
        shouldClearVideoSelection && shouldClearAudioSelection;
      const shouldFallbackToDefaultDevices =
        shouldClearVideoSelection || shouldClearAudioSelection;
      const stream = await getUserMediaWithDeviceFallback(
        primaryConstraints,
        shouldFallbackToDefaultDevices
          ? {
              video: !!primaryConstraints.video,
              audio: !!primaryConstraints.audio,
            }
          : undefined,
        () => {
          if (!isMountedRef.current) {
            return;
          }
          setSettingsState((prev) => {
            const selectedVideoDeviceId =
              !isDualSpecificSelectionRequest &&
              prev.cameraEnabled &&
              shouldClearVideoSelection &&
              requestedVideoDeviceId &&
              prev.selectedVideoDeviceId === requestedVideoDeviceId
                ? null
                : prev.selectedVideoDeviceId;
            const selectedAudioDeviceId =
              !isDualSpecificSelectionRequest &&
              prev.microphoneEnabled &&
              shouldClearAudioSelection &&
              requestedAudioDeviceId &&
              prev.selectedAudioDeviceId === requestedAudioDeviceId
                ? null
                : prev.selectedAudioDeviceId;

            if (
              selectedVideoDeviceId === prev.selectedVideoDeviceId &&
              selectedAudioDeviceId === prev.selectedAudioDeviceId
            ) {
              return prev;
            }

            return {
              ...prev,
              selectedVideoDeviceId,
              selectedAudioDeviceId,
            };
          });
        },
      );
      if (!isMountedRef.current) {
        stopMediaStreamsTracksOnce(stream);
        return;
      }
      stopMediaStreamsTracksOnce(stream);
      void refreshDevices();
    } catch (permissionError) {
      if (!isMountedRef.current) {
        return;
      }
      setError(mapVideoRecorderErrorMessage(permissionError));
      if (isDeviceSelectionError(permissionError)) {
        void refreshDevices();
      }
    } finally {
      permissionRequestInFlightRef.current = false;
      if (isMountedRef.current) {
        setIsRequestingPermissions(false);
      }
    }
  }, [capabilities.isSupported, refreshDevices, settings, status]);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    saveVideoRecorderSettings(settings);
  }, [settings]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      cleanupStreams();
    };
  }, [cleanupStreams]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden && recorderRef.current?.state === "recording") {
        try {
          recorderRef.current.pause();
          setStatus("paused");
          pausedAtRef.current = Date.now();
          clearElapsedTimer();
        } catch (pauseError) {
          console.error(pauseError);
          setError(mapVideoRecorderErrorMessage(pauseError));
          setStatus("error");
          cleanupStreams();
        }
      }
    };

    document.addEventListener(EVENT.VISIBILITY_CHANGE, onVisibilityChange);
    return () =>
      document.removeEventListener(EVENT.VISIBILITY_CHANGE, onVisibilityChange);
  }, [cleanupStreams, clearElapsedTimer]);

  const setSettings = useCallback(
    (
      next:
        | Partial<VideoRecorderSettings>
        | ((prev: VideoRecorderSettings) => VideoRecorderSettings),
    ) => {
      setSettingsState((prev) => {
        const nextValue =
          typeof next === "function"
            ? next(prev)
            : {
                ...prev,
                ...next,
              };

        const normalizedSettings = normalizeSettingsInput(
          nextValue,
          prev,
          capabilities.supportedMimeTypes,
        );

        if (areVideoRecorderSettingsEqual(prev, normalizedSettings)) {
          return prev;
        }

        return normalizedSettings;
      });
    },
    [capabilities.supportedMimeTypes],
  );

  const updateCameraLayout = useCallback(
    (
      next:
        | Partial<VideoRecorderOverlayLayout>
        | ((prev: VideoRecorderOverlayLayout) => VideoRecorderOverlayLayout),
    ) => {
      setSettingsState((prev) => {
        const nextValue = typeof next === "function" ? next(prev.camera) : next;
        const merged = {
          ...prev.camera,
          ...(isObject(nextValue) ? nextValue : {}),
        };
        const camera = normalizeOverlayLayoutInput(merged, prev.camera);
        if (areOverlayLayoutsEqual(camera, prev.camera)) {
          return prev;
        }
        return {
          ...prev,
          camera,
        };
      });
    },
    [],
  );

  const startElapsedTicker = useCallback(() => {
    clearElapsedTimer();
    elapsedTimerRef.current = window.setInterval(() => {
      if (!startedAtRef.current) {
        return;
      }
      const pausedDuration = pausedAccumulatedRef.current;
      const now = Date.now();
      setElapsedMs(Math.max(0, now - startedAtRef.current - pausedDuration));
    }, 100);
  }, [clearElapsedTimer]);

  const startRecording = useCallback(async () => {
    if (startRecordingInFlightRef.current) {
      return;
    }
    if (permissionRequestInFlightRef.current) {
      return;
    }

    if (!capabilities.isSupported) {
      setError(t("videoRecorder.errors.notSupported"));
      setStatus("error");
      return;
    }

    if (
      status === "recording" ||
      status === "paused" ||
      status === "preparing" ||
      status === "stopping"
    ) {
      return;
    }

    const requestId = startRecordingRequestIdRef.current + 1;
    startRecordingRequestIdRef.current = requestId;
    const assertStartRequestActive = () => {
      if (
        !isMountedRef.current ||
        requestId !== startRecordingRequestIdRef.current
      ) {
        throw new StartRecordingCancelledError();
      }
    };

    startRecordingInFlightRef.current = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(t("videoRecorder.errors.notSupported"));
      }

      setError(null);
      setResult(null);
      setStatus("preparing");
      chunksRef.current = [];
      startedAtRef.current = null;
      pausedAtRef.current = null;
      pausedAccumulatedRef.current = 0;
      setElapsedMs(0);

      const { width, height } = getVideoDimensions(
        settings.aspectRatio,
        settings.resolution,
      );

      const { staticCanvas, interactiveCanvas } = getExcalidrawCanvases();

      const compositionCanvas = document.createElement("canvas");
      compositionCanvas.width = width;
      compositionCanvas.height = height;
      compositionCanvasRef.current = compositionCanvas;

      const compositionContext = compositionCanvas.getContext("2d");
      if (!compositionContext) {
        throw new Error(t("videoRecorder.errors.contextUnavailable"));
      }

      if (settings.cameraEnabled) {
        const requestedVideoDeviceId = settings.selectedVideoDeviceId;
        const cameraStream = await getUserMediaWithDeviceFallback(
          {
            video: requestedVideoDeviceId
              ? { deviceId: { exact: requestedVideoDeviceId } }
              : true,
            audio: false,
          },
          requestedVideoDeviceId ? { video: true, audio: false } : undefined,
          () => {
            if (!isMountedRef.current) {
              return;
            }
            setSettingsState((prev) => {
              const selectedVideoDeviceId =
                prev.cameraEnabled &&
                prev.selectedVideoDeviceId === requestedVideoDeviceId
                  ? null
                  : prev.selectedVideoDeviceId;

              if (selectedVideoDeviceId === prev.selectedVideoDeviceId) {
                return prev;
              }

              return {
                ...prev,
                selectedVideoDeviceId,
              };
            });
          },
        );
        cameraStreamRef.current = cameraStream;
        assertStartRequestActive();

        const cameraVideo = document.createElement("video");
        cameraVideo.srcObject = cameraStream;
        cameraVideo.playsInline = true;
        cameraVideo.muted = true;
        cameraVideo.autoplay = true;
        await cameraVideo.play();
        assertStartRequestActive();
        cameraVideoRef.current = cameraVideo;
      }

      if (settings.microphoneEnabled) {
        const requestedAudioDeviceId = settings.selectedAudioDeviceId;
        const micStream = await getUserMediaWithDeviceFallback(
          {
            audio: requestedAudioDeviceId
              ? { deviceId: { exact: requestedAudioDeviceId } }
              : true,
            video: false,
          },
          requestedAudioDeviceId ? { audio: true, video: false } : undefined,
          () => {
            if (!isMountedRef.current) {
              return;
            }
            setSettingsState((prev) => {
              const selectedAudioDeviceId =
                prev.microphoneEnabled &&
                prev.selectedAudioDeviceId === requestedAudioDeviceId
                  ? null
                  : prev.selectedAudioDeviceId;

              if (selectedAudioDeviceId === prev.selectedAudioDeviceId) {
                return prev;
              }

              return {
                ...prev,
                selectedAudioDeviceId,
              };
            });
          },
        );
        microphoneStreamRef.current = micStream;
        assertStartRequestActive();
      }

      const renderFrame = () => {
        compositionContext.fillStyle = "#000000";
        compositionContext.fillRect(0, 0, width, height);

        drawCanvasContain(compositionContext, staticCanvas, width, height);
        drawCanvasContain(compositionContext, interactiveCanvas, width, height);

        if (cameraVideoRef.current && settings.cameraEnabled) {
          drawCameraOverlay({
            context: compositionContext,
            cameraVideo: cameraVideoRef.current,
            targetWidth: width,
            targetHeight: height,
            layout: settings.camera,
          });
        }

        renderFrameRef.current = requestAnimationFrame(renderFrame);
      };

      renderFrameRef.current = requestAnimationFrame(renderFrame);

      const canvasStream = compositionCanvas.captureStream(settings.fps);
      const composedStream = new MediaStream();
      canvasStream
        .getVideoTracks()
        .forEach((track) => composedStream.addTrack(track));
      microphoneStreamRef.current
        ?.getAudioTracks()
        .forEach((track) => composedStream.addTrack(track));
      recordingStreamRef.current = composedStream;

      const requestedMimeType = settings.mimeType.trim();
      const preferredMimeType = normalizeRecorderMimeType(
        requestedMimeType,
        capabilities.supportedMimeTypes,
      );
      const mimeTypeCandidates = Array.from(
        new Set([
          requestedMimeType,
          preferredMimeType,
          ...capabilities.supportedMimeTypes,
        ]),
      ).filter(Boolean);

      let selectedMimeType = mimeTypeCandidates[0] || preferredMimeType;
      let recorder: MediaRecorder | null = null;
      let recorderCreationError: unknown = null;

      for (const mimeType of mimeTypeCandidates) {
        try {
          recorder = new MediaRecorder(composedStream, { mimeType });
          selectedMimeType = mimeType;
          break;
        } catch (error) {
          recorderCreationError = error;
          if (!isRecoverableMediaRecorderMimeError(error)) {
            throw error;
          }
        }
      }

      if (!recorder) {
        try {
          recorder = new MediaRecorder(composedStream);
          selectedMimeType = recorder.mimeType || selectedMimeType;
        } catch {
          throw (
            recorderCreationError ||
            new Error("Unable to initialize media recorder")
          );
        }
      }

      recorderRef.current = recorder;
      const normalizedSelectedMimeType = (
        recorder.mimeType ||
        selectedMimeType ||
        ""
      ).trim();
      setSettingsState((prev) => {
        if (
          !normalizedSelectedMimeType ||
          prev.mimeType === normalizedSelectedMimeType
        ) {
          return prev;
        }
        const next = {
          ...prev,
          mimeType: normalizedSelectedMimeType,
        };
        saveVideoRecorderSettings(next);
        return next;
      });
      let didRecorderFail = false;

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        didRecorderFail = true;
        setError(
          mapVideoRecorderErrorMessage(getMediaRecorderRuntimeError(event)),
        );
        setStatus("error");
        cleanupStreams();
      };

      recorder.onstop = () => {
        if (didRecorderFail) {
          cleanupStreams();
          return;
        }

        const finalizedMimeType = (
          recorder?.mimeType ||
          selectedMimeType ||
          settings.mimeType
        ).trim();
        const blob = new Blob(chunksRef.current, {
          type: finalizedMimeType,
        });
        const durationMs =
          startedAtRef.current == null
            ? elapsedMs
            : Math.max(
                elapsedMs,
                Date.now() -
                  startedAtRef.current -
                  pausedAccumulatedRef.current -
                  (pausedAtRef.current ? Date.now() - pausedAtRef.current : 0),
              );

        setElapsedMs(durationMs);
        setResult({
          blob,
          mimeType: finalizedMimeType,
          durationMs,
          createdAt: Date.now(),
        });
        setStatus("completed");
        cleanupStreams();
      };

      startedAtRef.current = Date.now();
      recorder.start(MEDIA_RECORDER_TIMESLICE_MS);
      setStatus("recording");
      setDialogOpen(false);
      startElapsedTicker();
      void refreshDevices();
    } catch (startError) {
      if (
        startError instanceof StartRecordingCancelledError ||
        !isMountedRef.current ||
        requestId !== startRecordingRequestIdRef.current
      ) {
        cleanupStreams();
        return;
      }
      console.error(startError);
      setError(mapVideoRecorderErrorMessage(startError));
      setStatus("error");
      cleanupStreams();
      if (isDeviceSelectionError(startError)) {
        void refreshDevices();
      }
    } finally {
      startRecordingInFlightRef.current = false;
    }
  }, [
    capabilities,
    cleanupStreams,
    elapsedMs,
    refreshDevices,
    settings,
    startElapsedTicker,
    status,
  ]);

  const pauseRecording = useCallback(() => {
    if (recorderRef.current?.state !== "recording") {
      return;
    }
    try {
      recorderRef.current.pause();
      pausedAtRef.current = Date.now();
      setStatus("paused");
      clearElapsedTimer();
    } catch (pauseError) {
      console.error(pauseError);
      setError(mapVideoRecorderErrorMessage(pauseError));
      setStatus("error");
      cleanupStreams();
    }
  }, [cleanupStreams, clearElapsedTimer]);

  const resumeRecording = useCallback(() => {
    if (recorderRef.current?.state !== "paused") {
      return;
    }
    try {
      recorderRef.current.resume();
      if (pausedAtRef.current) {
        pausedAccumulatedRef.current += Date.now() - pausedAtRef.current;
        pausedAtRef.current = null;
      }
      setStatus("recording");
      startElapsedTicker();
    } catch (resumeError) {
      console.error(resumeError);
      setError(mapVideoRecorderErrorMessage(resumeError));
      setStatus("error");
      cleanupStreams();
    }
  }, [cleanupStreams, startElapsedTicker]);

  const stopRecording = useCallback(async () => {
    if (stopRecordingInFlightRef.current) {
      return;
    }

    if (status === "stopping") {
      return;
    }

    if (
      !recorderRef.current ||
      (recorderRef.current.state !== "recording" &&
        recorderRef.current.state !== "paused")
    ) {
      return;
    }

    stopRecordingInFlightRef.current = true;
    setStatus("stopping");
    clearElapsedTimer();

    await new Promise<void>((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder) {
        stopRecordingInFlightRef.current = false;
        resolve();
        return;
      }

      let settled = false;
      const finalize = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (stopRecordingTimeoutRef.current != null) {
          window.clearTimeout(stopRecordingTimeoutRef.current);
          stopRecordingTimeoutRef.current = null;
        }
        stopRecordingInFlightRef.current = false;
        stopRecordingFinalizeRef.current = null;
        resolve();
      };
      stopRecordingFinalizeRef.current = finalize;

      const handleStop = () => {
        recorder.removeEventListener("stop", handleStop);
        finalize();
      };
      recorder.addEventListener("stop", handleStop);
      stopRecordingTimeoutRef.current = window.setTimeout(() => {
        recorder.removeEventListener("stop", handleStop);
        setError(t("videoRecorder.errors.recordingFailed"));
        setStatus("error");
        cleanupStreams();
        finalize();
      }, STOP_RECORDING_TIMEOUT_MS);

      try {
        recorder.stop();
      } catch (stopError) {
        recorder.removeEventListener("stop", handleStop);
        setError(mapVideoRecorderErrorMessage(stopError));
        setStatus("error");
        cleanupStreams();
        finalize();
      }
    });
  }, [cleanupStreams, clearElapsedTimer, status]);

  const resetResult = useCallback(() => {
    setResult(null);
    setError(null);
    setElapsedMs(0);
    setStatus("idle");
  }, []);

  const downloadRecording = useCallback(
    (name: string) => {
      if (!result) {
        return;
      }
      setError(null);
      const extension = getFileExtensionFromMimeType(result.mimeType);
      const sanitizedName = sanitizeRecordingFileName(name);
      let url: string | null = null;
      let anchor: HTMLAnchorElement | null = null;

      try {
        url = URL.createObjectURL(result.blob);
        anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${sanitizedName}.${extension}`;
        document.body.appendChild(anchor);
        anchor.click();
      } catch (downloadError) {
        console.error(downloadError);
        setError(mapVideoRecorderErrorMessage(downloadError));
      } finally {
        if (anchor && anchor.parentNode) {
          try {
            anchor.parentNode.removeChild(anchor);
          } catch (removeError) {
            console.error(removeError);
          }
        }
        if (url) {
          try {
            URL.revokeObjectURL(url);
          } catch (revokeError) {
            console.error(revokeError);
          }
        }
      }
    },
    [result],
  );

  const isRecordingActive = status === "recording" || status === "paused";

  return {
    capabilities,
    settings,
    status,
    error,
    isDialogOpen,
    elapsedMs,
    result,
    devices,
    isRecordingActive,
    isRequestingPermissions,
    setDialogOpen,
    setSettings,
    updateCameraLayout,
    refreshDevices,
    requestMediaPermissions,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    resetResult,
    downloadRecording,
  };
};
