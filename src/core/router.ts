import { Espresso } from './Espresso.js';

/**
 * Creates a standalone, composable route group.
 * Attach it to the main app with `.use(group)` or `.mount('/prefix', group)`.
 */
export const router = (config?: ConstructorParameters<typeof Espresso>[0]): Espresso =>
  new Espresso(config);