export const departureLimits = Object.freeze({
  sampleAgeMs: 2500,
  clockSkewMs: 350,
  gpsAccuracyM: 8,
  routeOffsetM: 10,
  launchOffsetM: 5,
  stoppedSpeed: 0.3,
  movingSpeed: 1,
  motionHoldMs: 1000,
  observationWindowMs: 5000,
  observationSpanMs: 1000,
  projectionSeconds: 1,
  maxAcceleration: 6,
  maxJerk: 8,
  stablePredictionMs: 1000,
  scheduleToleranceMs: 500,
  maxTimingSpreadSeconds: 2
});

export function parseSpeedProfile(text) {
  const rows = text.trim().split(/\r?\n/).filter(row => row.trim());
  if (rows.length < 2 || rows.length > 100) {
    throw new Error("速度プロファイルは各車2〜100点で入力してください。");
  }

  const points = rows.map((row, index) => {
    const fields = row.split(",").map(field => field.trim());
    if (fields.length !== 2 || fields.some(field => !/^\d+(?:\.\d+)?$/.test(field))) {
      throw new Error(`${index + 1}点目は「距離[m],速度[km/h]」で入力してください。`);
    }
    const [distance, kmh] = fields.map(Number);
    if (!Number.isFinite(distance) || !Number.isFinite(kmh)) {
      throw new Error(`${index + 1}点目に有限の数値を入力してください。`);
    }
    return { distance, speed: kmh / 3.6 };
  });

  if (points[0].distance !== 0) throw new Error("最初の距離は0 mにしてください。");
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1];
    const next = points[i];
    if (next.distance <= previous.distance) throw new Error("距離は昇順で入力してください。");
    if (previous.speed === 0 && next.speed === 0) {
      throw new Error("連続する2点が0 km/hの場合は、間に速度点を追加してください。");
    }
  }
  return points;
}

export function profileTravelTime(profile, start, end, initialSpeed) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start ||
      end > profile.at(-1).distance ||
      (initialSpeed !== undefined && (!Number.isFinite(initialSpeed) || initialSpeed < 0))) {
    return null;
  }
  if (start === end) return 0;

  // 一定加速度区間では v² が距離に対して線形になる。
  let seconds = 0;
  for (let i = 1; i < profile.length; i++) {
    const left = profile[i - 1];
    const right = profile[i];
    const from = Math.max(start, left.distance);
    const to = Math.min(end, right.distance);
    if (from >= to) continue;

    const linkToObservedSpeed = from === start && initialSpeed !== undefined;
    const origin = linkToObservedSpeed ? from : left.distance;
    const speed = linkToObservedSpeed ? initialSpeed : left.speed;
    const speedSquaredAt = distance => {
      const fraction = (distance - origin) / (right.distance - origin);
      return (1 - fraction) * speed ** 2 + fraction * right.speed ** 2;
    };
    const speedSum = Math.sqrt(speedSquaredAt(from)) + Math.sqrt(speedSquaredAt(to));
    if (!(speedSum > 0) || !Number.isFinite(speedSum)) return null;
    seconds += 2 * (to - from) / speedSum;
  }
  return Number.isFinite(seconds) ? seconds : null;
}

// 速度差分は区間中点の加速度として扱い、直近窓の前半・後半で平均する。
export function estimateMotion(samples) {
  if (samples.length < 3) return null;
  const first = samples[0];
  const middle = samples[Math.floor(samples.length / 2)];
  const latest = samples.at(-1);
  const earlySpan = (middle.timestamp - first.timestamp) / 1000;
  const lateSpan = (latest.timestamp - middle.timestamp) / 1000;
  if (earlySpan <= 0 || lateSpan <= 0 ||
      (earlySpan + lateSpan) * 1000 < departureLimits.observationSpanMs) return null;

  const earlyAcceleration = (middle.speed - first.speed) / earlySpan;
  const lateAcceleration = (latest.speed - middle.speed) / lateSpan;
  const jerk = (lateAcceleration - earlyAcceleration) / ((earlySpan + lateSpan) / 2);
  const acceleration = lateAcceleration + jerk * lateSpan / 2;
  if (!Number.isFinite(acceleration) || !Number.isFinite(jerk) ||
      Math.abs(acceleration) > departureLimits.maxAcceleration ||
      Math.abs(jerk) > departureLimits.maxJerk) return null;
  return { acceleration, jerk };
}

export function predictMovingArrival(profile, station, mergeStation, speed, motion) {
  const baseline = profileTravelTime(profile, station, mergeStation, speed);
  if (baseline === null) return null;
  if (!motion || baseline === 0) return { seconds: baseline, correction: null };

  const { acceleration, jerk } = motion;
  const speedAt = t => speed + acceleration * t + jerk * t ** 2 / 2;
  const stationAt = t => station + speed * t + acceleration * t ** 2 / 2 + jerk * t ** 3 / 6;
  const horizon = departureLimits.projectionSeconds;
  const velocityExtremum = jerk === 0 ? 0 : -acceleration / jerk;
  if (speedAt(horizon) < 0 ||
      Math.abs(acceleration + jerk * horizon) > departureLimits.maxAcceleration ||
      (velocityExtremum > 0 && velocityExtremum < horizon && speedAt(velocityExtremum) < 0)) {
    return { seconds: baseline, correction: null };
  }

  let seconds;
  if (stationAt(horizon) >= mergeStation) {
    let low = 0;
    let high = horizon;
    for (let i = 0; i < 20; i++) {
      const middle = (low + high) / 2;
      if (stationAt(middle) < mergeStation) low = middle;
      else high = middle;
    }
    seconds = high;
  } else {
    const remaining = profileTravelTime(profile, stationAt(horizon), mergeStation, speedAt(horizon));
    if (remaining === null) return { seconds: baseline, correction: null };
    seconds = horizon + remaining;
  }
  return { seconds, correction: Math.abs(seconds - baseline) };
}

export function departureTime(peerArrivalMs, targetGapSeconds, launchTravelSeconds) {
  return peerArrivalMs + 1000 * (targetGapSeconds - launchTravelSeconds);
}

export function updateDepartureSchedule(previous, due, now) {
  const { scheduleToleranceMs, stablePredictionMs } = departureLimits;
  if (!Number.isFinite(due)) return { track: null, status: "unavailable" };
  const remaining = due - now;
  const matches = previous && Math.abs(previous.anchor - due) <= scheduleToleranceMs;
  const track = matches ? previous : { anchor: due, since: now };
  if (remaining <= 0) {
    const ready = matches && now - track.since >= stablePredictionMs && -remaining <= scheduleToleranceMs;
    return { track: null, status: ready ? "signal" : "missed" };
  }
  return { track, status: "countdown" };
}
