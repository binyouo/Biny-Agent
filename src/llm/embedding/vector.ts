// Use the intrinsic getter so proxies and altered prototypes cannot spoof the element type.
const typedArrayTagGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Float32Array.prototype) as object,
  Symbol.toStringTag
)?.get;

/** 向量统一在运行时边界完成有限数值校验和 L2 归一化。 */
export function normalizeEmbedding(values: ArrayLike<number>): Float32Array {
  if (values.length === 0) throw new Error("Embedding vector cannot be empty.");
  let squaredNorm = 0;
  const isFloat32Input = typedArrayTagGetter?.call(values) === "Float32Array";
  const vector = isFloat32Input
    ? new Float32Array(values.length)
    : new Float64Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error("Embedding vector contains a non-finite value.");
    }
    vector[index] = value;
    squaredNorm += value * value;
  }
  if (!Number.isFinite(squaredNorm) || squaredNorm <= 0) {
    throw new Error("Embedding vector must have a positive finite norm.");
  }
  const norm = Math.sqrt(squaredNorm);
  for (let index = 0; index < vector.length; index += 1) vector[index] = vector[index]! / norm;
  return isFloat32Input ? vector as Float32Array : new Float32Array(vector);
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) return Number.NEGATIVE_INFINITY;
  let similarity = 0;
  for (let index = 0; index < left.length; index += 1) similarity += left[index]! * right[index]!;
  return Number.isFinite(similarity) ? Math.max(-1, Math.min(1, similarity)) : Number.NEGATIVE_INFINITY;
}
