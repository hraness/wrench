const encoder = new TextEncoder();

function compareCodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/**
 * A locale-independent total order for strings that enter hashes, manifests,
 * checksums, or filesystem projections. UTF-16 breaks the otherwise-possible
 * tie when TextEncoder replaces two different lone surrogates with U+FFFD.
 */
export function compareUtf8(left: string, right: string): number {
  if (left === right) return 0;
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  const byteLengthDifference = leftBytes.byteLength - rightBytes.byteLength;
  return byteLengthDifference !== 0
    ? byteLengthDifference
    : compareCodeUnits(left, right);
}
