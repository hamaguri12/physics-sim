import * as THREE from 'three';

// ── ガラス棒と布の帯電シミュレーション ────────────────────────────────────
// createChargingSimulation({ scene, camera, domElement })
//   → { root, update(frameDt), tryGrab(x,y), updateGrab(x,y),
//        releaseGrab(), isGrabbing(), onWheel(deltaY), checkHover(x,y) }

export function createChargingSimulation({ scene, camera, domElement }) {

  const root = new THREE.Group();
  scene.add(root);

  // ── ガラス棒 ────────────────────────────────────────────────────────────
  const rodLength   = 7.0;
  const rodRadius   = 0.45;
  const rodAxisHalf = rodLength * 0.5;
  const rodGroup    = new THREE.Group();
  root.add(rodGroup);

  const rodMat = new THREE.MeshPhongMaterial({
    color: 0xd0e4ff, specular: 0xffffff, shininess: 220,
    transparent: true, opacity: 0.28, side: THREE.DoubleSide,
  });
  const rodCoreMat = new THREE.MeshPhongMaterial({
    color: 0xeaf3ff, specular: 0xffffff, shininess: 320,
    transparent: true, opacity: 0.11, side: THREE.DoubleSide,
  });
  const rodGeom = new THREE.CylinderGeometry(rodRadius, rodRadius, rodLength, 72, 1);
  rodGeom.rotateZ(Math.PI / 2);
  rodGroup.add(new THREE.Mesh(rodGeom, rodMat));
  const rodCoreGeom = new THREE.CylinderGeometry(rodRadius * 0.82, rodRadius * 0.82, rodLength * 0.999, 48, 1);
  rodCoreGeom.rotateZ(Math.PI / 2);
  rodGroup.add(new THREE.Mesh(rodCoreGeom, rodCoreMat));

  // ドラッグ用不可視ヒットシリンダー
  const rodHitGeom = new THREE.CylinderGeometry(rodRadius + 0.45, rodRadius + 0.45, rodLength, 24, 1);
  rodHitGeom.rotateZ(Math.PI / 2);
  const rodHitMesh = new THREE.Mesh(rodHitGeom, new THREE.MeshBasicMaterial({ visible: false }));
  rodGroup.add(rodHitMesh);

  // ── 布マテリアル ────────────────────────────────────────────────────────
  const clothMat = new THREE.MeshPhongMaterial({
    color: 0x9c1d2c, specular: 0x551823, shininess: 30, side: THREE.DoubleSide,
  });

  // ── 電荷 ────────────────────────────────────────────────────────────────
  const protonMat   = new THREE.MeshPhongMaterial({ color: 0xe63946, specular: 0x553333, shininess: 35 });
  const electronMat = new THREE.MeshPhongMaterial({ color: 0x7fd47a, specular: 0x446644, shininess: 45 });
  const protonGeom   = new THREE.SphereGeometry(0.16, 24, 18);
  const electronGeom = new THREE.SphereGeometry(0.13, 24, 18);

  const rodElectrons       = [];
  const clothChargeAnchors = [];
  const transferring       = [];

  function addRodProton(theta, xPos) {
    const mesh = new THREE.Mesh(protonGeom, protonMat);
    const r = rodRadius * 0.55;
    mesh.position.set(xPos, r * Math.cos(theta), r * Math.sin(theta));
    rodGroup.add(mesh);
  }
  function addRodElectron(theta, xPos) {
    const mesh = new THREE.Mesh(electronGeom, electronMat);
    const r = rodRadius * 0.55;
    mesh.position.set(xPos, r * Math.cos(theta), r * Math.sin(theta));
    rodGroup.add(mesh);
    rodElectrons.push({ mesh });
  }

  // ── パーティクル布 ──────────────────────────────────────────────────────
  const clothW = 3.35, clothH = 2.85;
  const segX = 34, segY = 28;
  const cols  = segX + 1, rows = segY + 1;
  const particleRadius = 0.028;

  const initialCenter = new THREE.Vector3(4.15, 2.65, 1.95);
  const initialEuler  = new THREE.Euler(-Math.PI / 14, 0, Math.PI / 16, 'XYZ');
  const initialRot    = new THREE.Matrix4().makeRotationFromEuler(initialEuler);

  const clothGeometry  = new THREE.BufferGeometry();
  const clothPositions = new Float32Array(cols * rows * 3);
  const clothNormals   = new Float32Array(cols * rows * 3);
  const clothUVs       = new Float32Array(cols * rows * 2);
  const clothIndices   = [];

  clothGeometry.setAttribute('position', new THREE.BufferAttribute(clothPositions, 3));
  clothGeometry.setAttribute('normal',   new THREE.BufferAttribute(clothNormals,   3));
  clothGeometry.setAttribute('uv',       new THREE.BufferAttribute(clothUVs,       2));

  for (let y = 0; y < segY; y++) {
    for (let x = 0; x < segX; x++) {
      const a = y * cols + x, b = a + 1, c = a + cols, d = c + 1;
      clothIndices.push(a, c, b, b, c, d);
    }
  }
  clothGeometry.setIndex(clothIndices);

  const clothMesh = new THREE.Mesh(clothGeometry, clothMat);
  clothMesh.frustumCulled = false;
  root.add(clothMesh);

  const particles = [];
  const pTmp  = new THREE.Vector3(), pTmp2 = new THREE.Vector3();
  const pTmp3 = new THREE.Vector3(), pTmp4 = new THREE.Vector3();
  const pTmp5 = new THREE.Vector3();
  const selfCollisionBuckets = new Map();

  function pIdx(ix, iy) { return iy * cols + ix; }

  function makeInitialWorldPos(u, v) {
    const local = new THREE.Vector3((u - 0.5) * clothW, (v - 0.5) * clothH, 0);
    local.applyMatrix4(initialRot);
    return local.add(initialCenter.clone());
  }

  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const u = ix / segX, v = iy / segY;
      const world = makeInitialWorldPos(u, v);
      particles.push({
        pos: world.clone(), prev: world.clone(), acc: new THREE.Vector3(),
        invMass: 1, grabbed: false, grabStrength: 0, rodContact: false,
      });
      clothUVs[(iy * cols + ix) * 2]     = u;
      clothUVs[(iy * cols + ix) * 2 + 1] = v;
    }
  }

  const constraints = [];
  function addConstraint(i1, i2, stiffness) {
    const rest = particles[i1].pos.distanceTo(particles[i2].pos);
    constraints.push({ i1, i2, rest, stiffness });
  }
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const i = pIdx(ix, iy);
      if (ix < segX) addConstraint(i, pIdx(ix + 1, iy), 1.0);
      if (iy < segY) addConstraint(i, pIdx(ix, iy + 1), 1.0);
      if (ix < segX && iy < segY) addConstraint(i, pIdx(ix + 1, iy + 1), 0.92);
      if (ix > 0  && iy < segY) addConstraint(i, pIdx(ix - 1, iy + 1), 0.92);
      if (ix + 2 <= segX) addConstraint(i, pIdx(ix + 2, iy), 0.45);
      if (iy + 2 <= segY) addConstraint(i, pIdx(ix, iy + 2), 0.45);
    }
  }

  function writeClothToGeometry() {
    const pa = clothGeometry.attributes.position;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i].pos, j = i * 3;
      pa.array[j] = p.x; pa.array[j + 1] = p.y; pa.array[j + 2] = p.z;
    }
    pa.needsUpdate = true;
  }
  function refreshClothShading() {
    clothGeometry.computeVertexNormals();
    clothGeometry.computeBoundingSphere();
  }
  writeClothToGeometry();
  refreshClothShading();

  // ── 布面サンプリング ────────────────────────────────────────────────────
  function sampleParticle(u, v, targetPos, targetNormal) {
    const gx = THREE.MathUtils.clamp(u, 0, 1) * segX;
    const gy = THREE.MathUtils.clamp(v, 0, 1) * segY;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(segX, x0 + 1), y1 = Math.min(segY, y0 + 1);
    const tx = gx - x0, ty = gy - y0;
    const p00 = particles[pIdx(x0, y0)].pos, p10 = particles[pIdx(x1, y0)].pos;
    const p01 = particles[pIdx(x0, y1)].pos, p11 = particles[pIdx(x1, y1)].pos;
    const a = targetPos || new THREE.Vector3();
    const n = targetNormal || new THREE.Vector3();
    a.copy(p00).multiplyScalar((1 - tx) * (1 - ty));
    a.addScaledVector(p10, tx * (1 - ty));
    a.addScaledVector(p01, (1 - tx) * ty);
    a.addScaledVector(p11, tx * ty);
    pTmp.copy(p10).sub(p00); pTmp2.copy(p01).sub(p00);
    n.copy(pTmp.cross(pTmp2)).normalize();
    if (!isFinite(n.x) || n.lengthSq() < 1e-8) n.set(0, 0, 1);
    return { position: a, normal: n };
  }

  function addClothCharge(kind, u, v) {
    const mesh = new THREE.Mesh(
      kind === 'proton' ? protonGeom  : electronGeom,
      kind === 'proton' ? protonMat   : electronMat
    );
    root.add(mesh);
    clothChargeAnchors.push({ kind, mesh, u, v, offset: kind === 'proton' ? 0.17 : 0.15 });
    return mesh;
  }
  function updateClothCharges() {
    const sp = new THREE.Vector3(), sn = new THREE.Vector3();
    for (const a of clothChargeAnchors) {
      sampleParticle(a.u, a.v, sp, sn);
      // mesh は root の子 → ローカル座標に変換
      a.mesh.position.copy(sp).addScaledVector(sn, a.offset).sub(root.position);
    }
  }

  function createSeededRandom(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  function generateSpreadUVs(count, options = {}) {
    const rand = options.rand || Math.random;
    const margin = options.margin ?? 0.08;
    const minDist = options.minDist ?? 0.19;
    const cands   = options.candidatesPerPoint ?? 80;
    const repelFrom   = options.repelFrom || [];
    const repelWeight = options.repelWeight ?? 0.55;
    const points = [];
    function nearestD2(u, v, list) {
      let best = Infinity;
      for (const p of list) { const d = (u - p.u) ** 2 + (v - p.v) ** 2; if (d < best) best = d; }
      return best;
    }
    for (let i = 0; i < count; i++) {
      let best = null, bestScore = -Infinity;
      for (let c = 0; c < cands; c++) {
        const u = THREE.MathUtils.lerp(margin, 1 - margin, rand());
        const v = THREE.MathUtils.lerp(margin, 1 - margin, rand());
        const score = Math.min(points.length ? nearestD2(u, v, points) : 1, minDist * minDist)
          + nearestD2(u, v, repelFrom) * repelWeight
          + Math.min(u - margin, 1 - margin - u, v - margin, 1 - margin - v) * 0.08;
        if (score > bestScore) { bestScore = score; best = { u, v }; }
      }
      points.push(best);
    }
    return points;
  }
  function generateTiledUVs(count, options = {}) {
    const rand   = options.rand || Math.random;
    const margin = options.margin ?? 0.10;
    const nCols  = options.cols ?? Math.max(1, Math.ceil(Math.sqrt(count * 1.5)));
    const nRows  = options.rows ?? Math.max(1, Math.ceil(count / nCols));
    const jitter = options.jitter ?? 0.22;
    const cellW = (1 - margin * 2) / nCols, cellH = (1 - margin * 2) / nRows;
    const cells = [];
    for (let row = 0; row < nRows; row++) {
      for (let col = 0; col < nCols; col++) {
        const cu = margin + (col + 0.5) * cellW, cv = margin + (row + 0.5) * cellH;
        cells.push({ col, row, cu, cv, priority: (cu - 0.5) ** 2 + (cv - 0.5) ** 2 + (rand() - 0.5) * 0.03 });
      }
    }
    cells.sort((a, b) => b.priority - a.priority);
    const chosen = cells.slice(0, Math.min(count, cells.length));
    for (let i = chosen.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1)); [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
    }
    return chosen.map(cell => ({
      u: THREE.MathUtils.clamp(cell.cu + (rand() - 0.5) * cellW * jitter * 2, margin, 1 - margin),
      v: THREE.MathUtils.clamp(cell.cv + (rand() - 0.5) * cellH * jitter * 2, margin, 1 - margin),
    }));
  }
  function chooseTransferUV(cu, cv) {
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 120; i++) {
      const r = THREE.MathUtils.lerp(0.04, 0.22, Math.random());
      const a = Math.random() * Math.PI * 2;
      const u = THREE.MathUtils.clamp(cu + Math.cos(a) * r + (Math.random() - 0.5) * 0.02, 0.04, 0.96);
      const v = THREE.MathUtils.clamp(cv + Math.sin(a) * r + (Math.random() - 0.5) * 0.02, 0.04, 0.96);
      let minD2 = Infinity, eMinD2 = Infinity;
      for (const anc of clothChargeAnchors) {
        const d = (u - anc.u) ** 2 + (v - anc.v) ** 2;
        if (d < minD2) minD2 = d;
        if (anc.kind === 'electron' && d < eMinD2) eMinD2 = d;
      }
      const score = Math.min(minD2, 0.18 * 0.18) * 2.2 + Math.min(eMinD2, 0.24 * 0.24) * 2.8
        - ((u - cu) ** 2 + (v - cv) ** 2) * 0.85
        + Math.min(u - 0.04, 0.96 - u, v - 0.04, 0.96 - v) * 0.05;
      if (score > bestScore) { bestScore = score; best = { u, v }; }
    }
    return best || { u: THREE.MathUtils.clamp(cu, 0.04, 0.96), v: THREE.MathUtils.clamp(cv, 0.04, 0.96) };
  }

  // ── 初期電荷配置 ────────────────────────────────────────────────────────
  (function seedInitialCharges() {
    const N = 24;
    for (let i = 0; i < N; i++) {
      const theta = i * 2.39996;
      const xPos = ((i + 0.5) / N - 0.5) * (rodLength - 0.8);
      if (i % 2 === 0) addRodProton(theta, xPos); else addRodElectron(theta, xPos);
    }
    const rand = createSeededRandom(123456789);
    const protonUVs   = generateTiledUVs(6, { rand, margin: 0.11, cols: 3, rows: 2, jitter: 0.26 });
    const electronUVs = generateSpreadUVs(6, { rand, margin: 0.10, minDist: 0.22, candidatesPerPoint: 110, repelFrom: protonUVs, repelWeight: 0.85 });
    for (const uv of protonUVs)   addClothCharge('proton',   uv.u, uv.v);
    for (const uv of electronUVs) addClothCharge('electron', uv.u, uv.v);
  })();
  updateClothCharges();

  // ── 物理定数 ────────────────────────────────────────────────────────────
  const gravity               = new THREE.Vector3(0, -10.3, 0);
  const groundY               = -5.0;
  const airDamping            = 0.9924;
  const solverIterations      = 10;
  const groundFriction        = 0.90;
  const rodFriction           = 0.72;
  const collisionMargin       = 0.018;
  const maxParticleStep       = 0.085;
  const selfCollisionRadius   = particleRadius * 3.05;
  const selfCollisionStiffness = 0.985;
  const dragKeepOut           = particleRadius + collisionMargin + 0.085;

  let lastCenter = new THREE.Vector3();
  let fixedStepCount = 0, geometryDirty = true;
  for (const p of particles) lastCenter.add(p.pos);
  lastCenter.multiplyScalar(1 / particles.length);

  function shiftAll(dx, dz) {
    rodGroup.position.x += dx;
    rodGroup.position.z += dz;
  }

  function updateCenterVelocity(dt) {
    const center = new THREE.Vector3();
    for (const p of particles) center.add(p.pos);
    center.multiplyScalar(1 / particles.length);
    lastCenter.copy(center);
  }

  // ── 衝突ヘルパー ────────────────────────────────────────────────────────
  const contactInfo = {
    touching: false, contactPoint: new THREE.Vector3(),
    contactX: 0, contactTheta: 0, contactCount: 0, averageNormal: new THREE.Vector3(),
  };
  const capsuleNearest = new THREE.Vector3(), capsuleNormal = new THREE.Vector3();

  function closestPointOnRodAxis(point, target) {
    // rodGroup は root の子。root を原点固定にするので rodGroup.position = ワールド位置
    const ox = rodGroup.position.x, oz = rodGroup.position.z;
    target.set(ox + THREE.MathUtils.clamp(point.x - ox, -rodAxisHalf, rodAxisHalf), 0, oz);
  }
  function projectPointOutsideRod(point, clearance, out) {
    closestPointOnRodAxis(point, capsuleNearest);
    capsuleNormal.copy(point).sub(capsuleNearest);
    const targetR = rodRadius + clearance;
    const distSq  = capsuleNormal.lengthSq();
    if (distSq >= targetR * targetR) return out.copy(point);
    let dist = Math.sqrt(distSq);
    if (dist < 1e-6) { capsuleNormal.set(0, 1, 0); dist = 1; }
    else capsuleNormal.multiplyScalar(1 / dist);
    return out.copy(capsuleNearest).addScaledVector(capsuleNormal, targetR);
  }
  function resolveRodCollision(particle, frictionScale) {
    closestPointOnRodAxis(particle.pos, capsuleNearest);
    capsuleNormal.copy(particle.pos).sub(capsuleNearest);
    const targetR = rodRadius + particleRadius + collisionMargin;
    const distSq  = capsuleNormal.lengthSq();
    if (distSq >= targetR * targetR) return false;
    let dist = Math.sqrt(distSq);
    if (dist < 1e-6) { capsuleNormal.set(0, 1, 0); dist = 1; }
    else capsuleNormal.multiplyScalar(1 / dist);
    particle.pos.copy(capsuleNearest).addScaledVector(capsuleNormal, targetR);
    const vel = pTmp2.copy(particle.pos).sub(particle.prev);
    const ns  = vel.dot(capsuleNormal);
    vel.addScaledVector(capsuleNormal, -ns);
    vel.multiplyScalar(particle.grabbed ? 0.16 : frictionScale);
    particle.prev.copy(particle.pos).sub(vel);
    particle.rodContact = true;
    contactInfo.touching = true;
    contactInfo.contactCount++;
    contactInfo.contactPoint.add(particle.pos);
    contactInfo.averageNormal.add(capsuleNormal);
    contactInfo.contactX     += particle.pos.x;
    contactInfo.contactTheta += Math.atan2(particle.pos.z, particle.pos.y);
    return true;
  }
  function resolveGroundCollision(particle) {
    if (particle.pos.y >= groundY + particleRadius) return false;
    particle.pos.y = groundY + particleRadius;
    const vel = particle.pos.clone().sub(particle.prev);
    vel.x *= groundFriction; vel.z *= groundFriction;
    if (vel.y < 0) vel.y = 0;
    particle.prev.copy(particle.pos).sub(vel);
    return true;
  }
  function satisfyConstraint(c) {
    const p1 = particles[c.i1], p2 = particles[c.i2];
    pTmp.copy(p2.pos).sub(p1.pos);
    const dist = pTmp.length();
    if (dist < 1e-6) return;
    const diff = (dist - c.rest) / dist;
    const w1 = p1.invMass, w2 = p2.invMass, wSum = w1 + w2;
    if (wSum <= 0) return;
    const corr = c.stiffness * diff;
    if (w1 > 0) p1.pos.addScaledVector(pTmp,  corr * (w1 / wSum));
    if (w2 > 0) p2.pos.addScaledVector(pTmp, -corr * (w2 / wSum));
  }
  function resolveSelfCollisions() {
    selfCollisionBuckets.clear();
    const cellSize = selfCollisionRadius * 1.2;
    const minDist  = selfCollisionRadius, minDistSq = minDist * minDist;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i].pos;
      const key = `${Math.floor(p.x / cellSize)},${Math.floor(p.y / cellSize)},${Math.floor(p.z / cellSize)}`;
      let b = selfCollisionBuckets.get(key);
      if (!b) { b = []; selfCollisionBuckets.set(key, b); }
      b.push(i);
    }
    for (let i = 0; i < particles.length; i++) {
      const p1 = particles[i];
      const cx = Math.floor(p1.pos.x / cellSize);
      const cy = Math.floor(p1.pos.y / cellSize);
      const cz = Math.floor(p1.pos.z / cellSize);
      const ix1 = i % cols, iy1 = (i / cols) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const bucket = selfCollisionBuckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          if (Math.abs(ix1 - j % cols) <= 1 && Math.abs(iy1 - ((j / cols) | 0)) <= 1) continue;
          const p2 = particles[j];
          pTmp.copy(p2.pos).sub(p1.pos);
          let distSq = pTmp.lengthSq();
          if (distSq >= minDistSq) continue;
          let dist = Math.sqrt(distSq);
          if (dist < 1e-7) {
            const a = (i * 12.9898 + j * 78.233) * 0.01;
            pTmp.set(Math.cos(a), Math.sin(a), Math.sin(a * 0.7));
            dist = pTmp.length(); pTmp.multiplyScalar(1 / Math.max(dist, 1e-7)); dist = 1;
          } else pTmp.multiplyScalar(1 / dist);
          const overlap = minDist - dist;
          const wSum = p1.invMass + p2.invMass;
          if (wSum <= 0) continue;
          const corr = overlap * selfCollisionStiffness * 0.78;
          p1.pos.addScaledVector(pTmp, -corr * (p1.invMass / wSum));
          p2.pos.addScaledVector(pTmp,  corr * (p2.invMass / wSum));
        }
      }
    }
  }

  // ── グラブ操作 ──────────────────────────────────────────────────────────
  const clothRaycaster = new THREE.Raycaster();
  const clothNDC       = new THREE.Vector2();
  let grabbing = false;
  const grabTarget        = new THREE.Vector3(), smoothedGrabTarget = new THREE.Vector3();
  const grabStartPoint    = new THREE.Vector3();
  const grabLocalOffsets  = [], grabIndices = [];
  const camForward = new THREE.Vector3(), camRight = new THREE.Vector3(), camUp = new THREE.Vector3();
  let grabDepth = 0, grabDepthOffset = 0;
  let grabStartScreenX = 0, grabStartScreenY = 0;
  let lastPointerX = 0, lastPointerY = 0;

  function setNDC(x, y) {
    clothNDC.x = (x / window.innerWidth) * 2 - 1;
    clothNDC.y = -(y / window.innerHeight) * 2 + 1;
  }
  function pickGrabParticles(hitPoint) {
    grabIndices.length = grabLocalOffsets.length = 0;
    const influenceRadius = 0.24;
    const scored = [];
    for (let i = 0; i < particles.length; i++) {
      const d2 = particles[i].pos.distanceToSquared(hitPoint);
      if (d2 < influenceRadius * influenceRadius) scored.push({ i, d2 });
    }
    scored.sort((a, b) => a.d2 - b.d2);
    const selected = scored.slice(0, 9);
    if (!selected.length) {
      let best = 0, bestD2 = Infinity;
      for (let i = 0; i < particles.length; i++) {
        const d2 = particles[i].pos.distanceToSquared(hitPoint);
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
      selected.push({ i: best, d2: bestD2 });
    }
    for (const s of selected) {
      grabIndices.push(s.i);
      grabLocalOffsets.push(particles[s.i].pos.clone().sub(hitPoint).multiplyScalar(0.42));
      particles[s.i].grabbed = true;
      particles[s.i].grabStrength = THREE.MathUtils.clamp(1.15 - Math.sqrt(s.d2) / influenceRadius, 0.32, 1.0);
    }
  }
  function clearGrabState() {
    for (const i of grabIndices) { particles[i].grabbed = false; particles[i].grabStrength = 0; }
    grabIndices.length = grabLocalOffsets.length = 0;
  }
  function tryParticleGrabFallback(x, y) {
    let bestIndex = -1, bestDist2 = Infinity;
    const threshold2 = 42 * 42;
    for (let i = 0; i < particles.length; i++) {
      pTmp5.copy(particles[i].pos).project(camera);
      if (pTmp5.z < -1 || pTmp5.z > 1) continue;
      const sx = (pTmp5.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-pTmp5.y * 0.5 + 0.5) * window.innerHeight;
      const d2 = (sx - x) ** 2 + (sy - y) ** 2;
      if (d2 < bestDist2 && d2 <= threshold2) { bestDist2 = d2; bestIndex = i; }
    }
    return bestIndex === -1 ? null : particles[bestIndex].pos.clone();
  }

  function tryGrab(x, y) {
    if (!root.visible) return false;
    setNDC(x, y);
    clothRaycaster.setFromCamera(clothNDC, camera);
    const hits = clothRaycaster.intersectObject(clothMesh, false);
    const hitPoint = hits.length ? hits[0].point.clone() : tryParticleGrabFallback(x, y);
    if (!hitPoint) return false;
    grabTarget.copy(hitPoint); smoothedGrabTarget.copy(hitPoint); grabStartPoint.copy(hitPoint);
    grabStartScreenX = x; grabStartScreenY = y; lastPointerX = x; lastPointerY = y;
    camera.getWorldDirection(camForward);
    grabDepth = Math.max(0.8, hitPoint.clone().sub(camera.position).dot(camForward));
    grabDepthOffset = 0;
    clearGrabState(); pickGrabParticles(hitPoint);
    grabbing = true;
    domElement.style.cursor = 'grabbing';
    return true;
  }
  function updateGrab(x, y) {
    if (!grabbing) return;
    lastPointerX = x; lastPointerY = y;
    camera.getWorldDirection(camForward);
    camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const depth = THREE.MathUtils.clamp(grabDepth + grabDepthOffset, 0.8, 40);
    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    const visH = 2 * Math.tan(fovRad * 0.5) * depth;
    const visW = visH * camera.aspect;
    grabTarget.copy(grabStartPoint)
      .addScaledVector(camRight,  (x - grabStartScreenX) * (visW / window.innerWidth))
      .addScaledVector(camUp,    -(y - grabStartScreenY) * (visH / window.innerHeight))
      .addScaledVector(camForward, grabDepthOffset);
    projectPointOutsideRod(grabTarget, dragKeepOut, pTmp5);
    if (pTmp5.distanceToSquared(grabTarget) > 1e-10) grabTarget.lerp(pTmp5, 0.9);
  }
  function releaseGrab() {
    grabbing = false;
    clearGrabState();
    domElement.style.cursor = '';
  }
  function checkHover(x, y) {
    if (grabbing || !root.visible) return false;
    setNDC(x, y);
    clothRaycaster.setFromCamera(clothNDC, camera);
    return clothRaycaster.intersectObject(clothMesh, false).length > 0 || !!tryParticleGrabFallback(x, y);
  }
  function onWheel(deltaY) {
    if (!grabbing) return;
    const step = Math.max(0.08, grabDepth * 0.045);
    grabDepthOffset += deltaY > 0 ? -step : step;
    grabDepthOffset = THREE.MathUtils.clamp(grabDepthOffset, -grabDepth + 0.8, 14);
    updateGrab(lastPointerX, lastPointerY);
  }

  function solveGrabConstraint() {
    if (!grabbing) return;
    pTmp4.copy(grabTarget).sub(smoothedGrabTarget);
    const maxAdv = contactInfo.touching ? 0.020 : 0.030;
    const len = pTmp4.length();
    if (len > maxAdv) pTmp4.multiplyScalar(maxAdv / len);
    smoothedGrabTarget.add(pTmp4);
    projectPointOutsideRod(smoothedGrabTarget, dragKeepOut, pTmp5);
    if (pTmp5.distanceToSquared(smoothedGrabTarget) > 1e-10) smoothedGrabTarget.lerp(pTmp5, 0.92);
    for (let n = 0; n < grabIndices.length; n++) {
      const i = grabIndices[n], p = particles[i];
      const target = pTmp3.copy(smoothedGrabTarget).add(grabLocalOffsets[n]);
      projectPointOutsideRod(target, particleRadius + collisionMargin + 0.04, pTmp5);
      if (pTmp5.distanceToSquared(target) > 1e-10) target.copy(pTmp5);
      const strength = contactInfo.touching ? (0.09 + 0.04 * p.grabStrength) : (0.12 + 0.05 * p.grabStrength);
      const bx = p.pos.x, by = p.pos.y, bz = p.pos.z;
      p.pos.lerp(target, strength);
      p.prev.set(p.pos.x - (p.pos.x - bx) * 0.01, p.pos.y - (p.pos.y - by) * 0.01, p.pos.z - (p.pos.z - bz) * 0.01);
    }
  }

  // ── 電子移送 ────────────────────────────────────────────────────────────
  let rubAccumulator = 0;
  const prevRubContactPoint = new THREE.Vector3();
  let prevRubContactX = 0, prevRubContactTheta = 0;
  let hadRubContactLastFrame = false, contactDwellTime = 0;

  function wrapAngleDelta(a, b) {
    let d = a - b;
    while (d >  Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
  function initiateTransfer(contactX, contactTheta) {
    if (!rodElectrons.length) return;
    let bestIdx = -1, bestScore = Infinity;
    for (let i = 0; i < rodElectrons.length; i++) {
      const pos = rodElectrons[i].mesh.position;
      let dtheta = Math.atan2(pos.z, pos.y) - contactTheta;
      while (dtheta >  Math.PI) dtheta -= Math.PI * 2;
      while (dtheta < -Math.PI) dtheta += Math.PI * 2;
      const score = (pos.x - contactX) ** 2 + (dtheta * rodRadius) ** 2;
      if (score < bestScore) { bestScore = score; bestIdx = i; }
    }
    if (bestIdx < 0) return;
    const selected = rodElectrons.splice(bestIdx, 1)[0];
    const worldStart = new THREE.Vector3();
    selected.mesh.getWorldPosition(worldStart);
    rodGroup.remove(selected.mesh);
    root.add(selected.mesh);
    selected.mesh.position.copy(worldStart).sub(root.position); // root-local
    const boundsHint = contactInfo.contactPoint.clone();
    let bestParticle = 0, bestD2 = Infinity;
    for (let i = 0; i < particles.length; i++) {
      const d2 = particles[i].pos.distanceToSquared(boundsHint);
      if (d2 < bestD2) { bestD2 = d2; bestParticle = i; }
    }
    const gridX = bestParticle % cols, gridY = Math.floor(bestParticle / cols);
    const targetUV = chooseTransferUV(
      THREE.MathUtils.clamp(gridX / segX, 0.04, 0.96),
      THREE.MathUtils.clamp(gridY / segY, 0.04, 0.96)
    );
    transferring.push({
      mesh: selected.mesh, start: worldStart.clone(),
      u: targetUV.u, v: targetUV.v, t: 0,
      duration: 0.55 + Math.random() * 0.2,
      arcHeight: 0.25 + Math.random() * 0.2,
    });
  }
  function updateTransfers(dt) {
    const tp = new THREE.Vector3(), tn = new THREE.Vector3();
    for (let i = transferring.length - 1; i >= 0; i--) {
      const tr = transferring[i];
      tr.t += dt / tr.duration;
      const k = THREE.MathUtils.clamp(tr.t, 0, 1);
      sampleParticle(tr.u, tr.v, tp, tn);
      tp.addScaledVector(tn, 0.16);
      if (k >= 1) {
        clothChargeAnchors.push({ kind: 'electron', mesh: tr.mesh, u: tr.u, v: tr.v, offset: 0.16 });
        tr.mesh.position.copy(tp).sub(root.position); // root-local
        transferring.splice(i, 1);
        continue;
      }
      const s = k * k * (3 - 2 * k);
      const _worldLerp = new THREE.Vector3().lerpVectors(tr.start, tp, s);
      _worldLerp.y += Math.sin(Math.PI * s) * tr.arcHeight;
      tr.mesh.position.copy(_worldLerp).sub(root.position); // root-local
    }
  }
  function updateRubbing(dt) {
    const hasGoodContact = grabbing && contactInfo.touching && contactInfo.contactCount >= 10;
    if (!hasGoodContact) {
      rubAccumulator = Math.max(0, rubAccumulator - dt * 2.2);
      contactDwellTime = 0; hadRubContactLastFrame = false; return;
    }
    contactDwellTime += dt;
    const contactNormal = pTmp.copy(contactInfo.averageNormal);
    if (contactNormal.lengthSq() < 1e-8) contactNormal.set(0, 1, 0); else contactNormal.normalize();
    let tangentialTravel = 0, normalTravel = 0;
    if (hadRubContactLastFrame) {
      pTmp2.copy(contactInfo.contactPoint).sub(prevRubContactPoint);
      normalTravel = Math.abs(pTmp2.dot(contactNormal));
      pTmp2.addScaledVector(contactNormal, -pTmp2.dot(contactNormal));
      tangentialTravel = Math.max(pTmp2.length(),
        Math.abs(contactInfo.contactX - prevRubContactX),
        Math.abs(wrapAngleDelta(contactInfo.contactTheta, prevRubContactTheta)) * rodRadius
      );
    }
    prevRubContactPoint.copy(contactInfo.contactPoint);
    prevRubContactX = contactInfo.contactX;
    prevRubContactTheta = contactInfo.contactTheta;
    hadRubContactLastFrame = true;
    const tangentialSpeed = tangentialTravel / Math.max(dt, 1e-5);
    const contactCoverage = THREE.MathUtils.clamp((contactInfo.contactCount - 9) / 14, 0, 1);
    const isRealRub = contactDwellTime > 0.16 && tangentialSpeed > 0.36
      && (tangentialTravel - normalTravel * 0.75) > 0.0065 && tangentialTravel > 0.0065;
    if (isRealRub) {
      rubAccumulator += tangentialSpeed * (0.34 + 0.55 * contactCoverage) * dt;
      while (rubAccumulator > 1.95) {
        rubAccumulator -= 1.15;
        initiateTransfer(contactInfo.contactX, contactInfo.contactTheta);
        if (!rodElectrons.length) { rubAccumulator = 0; break; }
      }
    } else {
      rubAccumulator = Math.max(0, rubAccumulator - dt * 0.9);
    }
  }

  // ── 物理ステップ ────────────────────────────────────────────────────────
  function beginContactFrame() {
    contactInfo.touching = false;
    contactInfo.contactPoint.set(0, 0, 0);
    contactInfo.contactX = contactInfo.contactTheta = contactInfo.contactCount = 0;
    contactInfo.averageNormal.set(0, 0, 0);
  }
  function integrateParticles(dt) {
    const dt2 = dt * dt, maxStepSq = maxParticleStep * maxParticleStep;
    for (const p of particles) {
      const damping = p.grabbed ? 0.42 : (p.rodContact ? 0.84 : airDamping);
      const velocity = pTmp.copy(p.pos).sub(p.prev).multiplyScalar(damping);
      const stepSq = velocity.lengthSq();
      if (stepSq > maxStepSq) velocity.multiplyScalar(maxParticleStep / Math.sqrt(stepSq));
      p.prev.copy(p.pos); p.acc.copy(gravity);
      p.pos.add(velocity).addScaledVector(p.acc, dt2); p.rodContact = false;
    }
  }
  function solveConstraintsAndCollisions() {
    beginContactFrame();
    const doMid = grabbing || ((fixedStepCount & 1) === 0);
    for (let iter = 0; iter < solverIterations; iter++) {
      for (let i = 0; i < constraints.length; i++) satisfyConstraint(constraints[i]);
      solveGrabConstraint();
      const fric = iter === solverIterations - 1 ? rodFriction : 0.82;
      for (const p of particles) { resolveRodCollision(p, fric); resolveGroundCollision(p); }
      const runSelf = iter === solverIterations - 1 || (doMid && iter === solverIterations - 3);
      if (runSelf) {
        resolveSelfCollisions();
        for (const p of particles) { resolveRodCollision(p, rodFriction); resolveGroundCollision(p); }
      }
    }
    if (contactInfo.contactCount > 0) {
      const n = contactInfo.contactCount;
      contactInfo.contactPoint.divideScalar(n);
      contactInfo.contactX     /= n;
      contactInfo.contactTheta /= n;
      contactInfo.averageNormal.divideScalar(n);
    }
  }

  // ── ガラス棒ドラッグ ──────────────────────────────────────────────────────
  const _rdRc  = new THREE.Raycaster();
  const _rdNDC = new THREE.Vector2();
  const _rdHit = new THREE.Vector3();
  const _rdDP  = new THREE.Plane();
  const _rdOff = new THREE.Vector3();
  let draggingRod = false;

  function setRodNDC(cx, cy) {
    _rdNDC.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
  }

  function tryDragRod(cx, cy) {
    if (!root.visible || grabbing) return false;
    setRodNDC(cx, cy);
    _rdRc.setFromCamera(_rdNDC, camera);
    const hits = _rdRc.intersectObject(rodHitMesh, false);
    if (!hits.length) return false;
    const hp = hits[0].point;
    _rdOff.set(rodGroup.position.x - hp.x, 0, rodGroup.position.z - hp.z);
    _rdDP.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), hp);
    draggingRod = true;
    domElement.style.cursor = 'grabbing';
    return true;
  }

  function updateDragRod(cx, cy) {
    if (!draggingRod) return;
    setRodNDC(cx, cy);
    _rdRc.setFromCamera(_rdNDC, camera);
    if (_rdRc.ray.intersectPlane(_rdDP, _rdHit)) {
      rodGroup.position.x = _rdHit.x + _rdOff.x;
      rodGroup.position.z = _rdHit.z + _rdOff.z;
    }
  }

  function releaseDragRod() {
    draggingRod = false;
    domElement.style.cursor = '';
  }

  function checkHoverRod(cx, cy) {
    if (!root.visible || grabbing) return false;
    setRodNDC(cx, cy);
    _rdRc.setFromCamera(_rdNDC, camera);
    return _rdRc.intersectObject(rodHitMesh, false).length > 0;
  }

  // 棒の代表電荷3点（ワールド座標）
  function getRodChargePoints() {
    const ox = rodGroup.position.x, oz = rodGroup.position.z;
    const half = rodAxisHalf * 0.65;
    return [
      new THREE.Vector3(ox - half, 0, oz),
      new THREE.Vector3(ox,        0, oz),
      new THREE.Vector3(ox + half, 0, oz),
    ];
  }

  // 棒の正味電荷（こすった分だけ増える）
  function getRodNetCharge() {
    return 12 - rodElectrons.length; // 初期12個の電子が布に移るほど正電荷が増える
  }

  // 布の各電荷位置とその符号（+1/-1）をワールド座標で返す
  const _wpTmp = new THREE.Vector3();
  function getClothChargePoints() {
    const result = [];
    for (const a of clothChargeAnchors) {
      a.mesh.getWorldPosition(_wpTmp);
      result.push({ x: _wpTmp.x, y: _wpTmp.y, z: _wpTmp.z, charge: a.kind === 'proton' ? 1 : -1 });
    }
    return result;
  }

  // ── パブリック update ───────────────────────────────────────────────────
  let accumulator = 0;
  const fixedDt   = 1 / 90;
  const maxFrameDt = 1 / 24;
  const maxSubsteps = 3;

  function update(frameDt) {
    if (!root.visible) return;
    accumulator += Math.min(frameDt, maxFrameDt);
    let substeps = 0;
    while (accumulator >= fixedDt && substeps < maxSubsteps) {
      integrateParticles(fixedDt);
      solveConstraintsAndCollisions();
      updateCenterVelocity(fixedDt);
      updateRubbing(fixedDt);
      updateTransfers(fixedDt);
      geometryDirty = true;
      fixedStepCount++;
      accumulator -= fixedDt;
      substeps++;
    }
    if (substeps === maxSubsteps) accumulator = 0;
    if (geometryDirty) {
      writeClothToGeometry();
      refreshClothShading();
      updateClothCharges();
      geometryDirty = false;
    }
  }

  return {
    root, update,
    tryGrab, updateGrab, releaseGrab, isGrabbing: () => grabbing, onWheel, checkHover,
    tryDragRod, updateDragRod, releaseDragRod, isDraggingRod: () => draggingRod,
    getRodChargePoints, getRodNetCharge, checkHoverRod,
    getClothChargePoints,
  };
}
