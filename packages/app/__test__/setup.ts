import { afterAll } from "vitest";

// Preact schedules effects with a 35ms timer that calls the global cancelAnimationFrame. A jsdom file
// that ends inside that window tears the global down first, and the late timer throws an unhandled
// ReferenceError that fails the run. Let pending frames drain before the environment goes.
afterAll(async () => {
  if (typeof window !== "undefined") await new Promise((resolve) => setTimeout(resolve, 50));
});
