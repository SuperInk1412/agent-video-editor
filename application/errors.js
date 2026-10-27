export function fault(code, message, details = {}) {
  const status = ({ REV_CONFLICT: 409, REQUEST_ID_CONFLICT: 409, HISTORY_EMPTY: 409,
    PROJECT_EXISTS: 409, PROJECT_NOT_FOUND: 404, JOB_NOT_FOUND: 404, ARTIFACT_NOT_FOUND: 404,
    UNKNOWN_COMMIT_STATE: 409, RUNTIME_EXISTS: 409 })[code] || 400;
  return Object.assign(new Error(message), { code, status, ...details });
}

export function errorData(error) {
  return { code: error.code || 'INTERNAL_ERROR', message: error.message,
    retryable: ['REV_CONFLICT', 'LOCK_TIMEOUT', 'RUNTIME_UNAVAILABLE'].includes(error.code),
    ...Object.fromEntries(['issues', 'currentRev', 'requestId'].filter((key) => error[key] !== undefined).map((key) => [key, error[key]])) };
}
