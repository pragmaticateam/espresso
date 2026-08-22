export type Split<S extends string> = S extends `${infer Head}/${infer Tail}`
  ? [Head, ...Split<Tail>]
  : [S];

type ParamsFromSegments<Segs extends readonly unknown[]> = Segs extends readonly [
  infer Head,
  ...infer Tail,
]
  ? Head extends `:${infer Name}`
    ? { [K in Name]: string } & ParamsFromSegments<Tail>
    : Head extends '*'
      ? { '*': string }
      : ParamsFromSegments<Tail>
  : {};

/**
 * Infers route params from a path template.
 *
 * `ParamsFromPath<'/users/:id/comments/:commentId'>` => `{ id: string } & { commentId: string }`
 */
export type ParamsFromPath<Path extends string> = ParamsFromSegments<Split<Path>>;