// How the tuner prints a number so it pastes into Python, Swift and Kotlin as a float.

export function number(value, decimals = 3) {
  const fixed = Number(value.toFixed(decimals));
  return Number.isInteger(fixed) ? `${fixed}.0` : String(fixed);
}
