export type Vector3 = readonly [number, number, number];

export type PreparedImpulseTrace = Readonly<{
  points: readonly Vector3[];
  peakMg: number;
  energyMg2: number;
}>;

function magnitudeSquared(vector: Vector3): number {
  return vector[0] ** 2 + vector[1] ** 2 + vector[2] ** 2;
}

export function prepareImpulseTrace(
  samples: readonly Vector3[],
): PreparedImpulseTrace {
  if (
    samples.length === 0 ||
    samples.some((sample) =>
      sample.some((component) => !Number.isFinite(component)),
    )
  ) {
    throw new Error("Impulse trace must contain finite samples");
  }

  const magnitudesSquared = samples.map(magnitudeSquared);
  const energyMg2 = magnitudesSquared.reduce((sum, value) => sum + value, 0);
  const peakMg = Math.sqrt(Math.max(...magnitudesSquared));
  if (peakMg === 0) throw new Error("Impulse trace must contain movement");

  return {
    points: samples.map(
      (sample): Vector3 => [
        sample[0] / peakMg,
        sample[1] / peakMg,
        sample[2] / peakMg,
      ],
    ),
    peakMg,
    energyMg2,
  };
}

function pointDistance(left: Vector3, right: Vector3): number {
  return Math.hypot(
    left[0] - right[0],
    left[1] - right[1],
    left[2] - right[2],
  );
}

function validPreparedTrace(trace: PreparedImpulseTrace): boolean {
  return (
    trace.points.length > 0 &&
    Number.isFinite(trace.peakMg) &&
    trace.peakMg > 0 &&
    Number.isFinite(trace.energyMg2) &&
    trace.energyMg2 > 0 &&
    trace.points.every((point) =>
      point.every((component) => Number.isFinite(component)),
    )
  );
}

export function dtwDistance(
  left: PreparedImpulseTrace,
  right: PreparedImpulseTrace,
): number {
  if (!validPreparedTrace(left) || !validPreparedTrace(right)) {
    throw new Error("DTW requires valid prepared impulse traces");
  }

  const rows = left.points;
  const columns = right.points;
  const band = Math.max(
    Math.abs(rows.length - columns.length),
    Math.ceil(Math.max(rows.length, columns.length) * 0.25),
  );
  let previousCosts = new Array(columns.length + 1).fill(Infinity);
  let previousLengths = new Array(columns.length + 1).fill(0);
  previousCosts[0] = 0;

  for (let row = 1; row <= rows.length; row++) {
    const costs = new Array(columns.length + 1).fill(Infinity);
    const lengths = new Array(columns.length + 1).fill(0);
    const from = Math.max(1, row - band);
    const to = Math.min(columns.length, row + band);
    for (let column = from; column <= to; column++) {
      const predecessors = [
        { cost: previousCosts[column - 1], length: previousLengths[column - 1] },
        { cost: previousCosts[column], length: previousLengths[column] },
        { cost: costs[column - 1], length: lengths[column - 1] },
      ];
      const best = predecessors.reduce((current, candidate) =>
        candidate.cost < current.cost ? candidate : current,
      );
      if (!Number.isFinite(best.cost)) continue;
      costs[column] =
        best.cost + pointDistance(rows[row - 1], columns[column - 1]);
      lengths[column] = best.length + 1;
    }
    previousCosts = costs;
    previousLengths = lengths;
  }

  const pathLength = previousLengths[columns.length];
  if (!Number.isFinite(previousCosts[columns.length]) || pathLength === 0) {
    throw new Error("DTW could not align impulse traces");
  }
  return previousCosts[columns.length] / pathLength;
}
