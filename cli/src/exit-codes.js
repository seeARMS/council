export const EXIT_CODES = {
  OK: 0,
  RUNTIME_ERROR: 1,
  USAGE_ERROR: 2,
  NO_MEMBER_RESPONSES: 3,
  SUMMARY_FAILED: 4
};

export function exitCodeForResult(result) {
  const hasMemberResponse = result.members.some((member) => member.status === 'ok');

  if (hasMemberResponse && result.summary?.status === 'ok') {
    return EXIT_CODES.OK;
  }

  if (!hasMemberResponse) {
    return EXIT_CODES.NO_MEMBER_RESPONSES;
  }

  return EXIT_CODES.SUMMARY_FAILED;
}
