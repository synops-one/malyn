// Deliberately flawed teaching fixture, not a production utility.
export async function retry(operation, attempts = 3) {
  for (let i = 0; i <= attempts; i++) {
    try { return operation(); }
    catch (error) { if (i === attempts) throw error; }
  }
}
