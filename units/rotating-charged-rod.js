import * as THREE from 'three';

// ── 固定台座付き帯電ガラス棒（回転のみ）─────────────────────────────────
// createRotatingChargedRod({ position, initialAngle })
//   → THREE.Group
//
// 物理モデル:
//   ・XZ 位置は固定（並進なし）
//   ・Y 軸まわりの回転のみ（ベアリング台）
//   ・addForce(fx, fz, appPx, appPz) でトルクを積算
//   ・update(dt) でオイラー積分 → 指数減衰
//
// 公開 API:
//   userData.update(dt)
//   userData.addForce(fx, fz, appPx, appPz)
//   userData.getChargePoints()  → THREE.Vector3[] （棒軸3点・ワールド座標）

export function createRotatingChargedRod({ position = [0, 0, 0], initialAngle = 0 } = {}) {
  const root = new THREE.Group();
  root.position.set(...position);
  const baseY   = position[1];
  const FIXED_PX = position[0];
  const FIXED_PZ = position[2];

  const spinGroup = new THREE.Group();
  spinGroup.rotation.y = initialAngle;
  root.add(spinGroup);

  // ── 回転台 ────────────────────────────────────────────────────────────
  const platBodyMat = new THREE.MeshPhongMaterial({ color: 0xf5cba7, specular: 0x885533, shininess: 40 });

  spinGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(4.0, 4.2, 0.45, 64), platBodyMat));

  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.35, 0.55, 24), platBodyMat);
  post.position.y = 0.5;
  spinGroup.add(post);

  // ── ガラス棒グループ ─────────────────────────────────────────────────
  const rodGroup = new THREE.Group();
  rodGroup.position.y = 0.70;
  spinGroup.add(rodGroup);

  const rodLength   = 7.0;
  const rodRadius   = 0.45;
  const rodAxisHalf = rodLength * 0.5;

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

  const coreGeom = new THREE.CylinderGeometry(rodRadius * 0.82, rodRadius * 0.82, rodLength * 0.999, 48, 1);
  coreGeom.rotateZ(Math.PI / 2);
  rodGroup.add(new THREE.Mesh(coreGeom, rodCoreMat));

  // 陽子 12 個（電子なし = 正帯電）
  const protonMat  = new THREE.MeshPhongMaterial({ color: 0xe63946, specular: 0x553333, shininess: 35 });
  const protonGeom = new THREE.SphereGeometry(0.16, 24, 18);
  for (let i = 0; i < 12; i++) {
    const theta = i * 2.39996;
    const xPos  = ((i + 0.5) / 12 - 0.5) * (rodLength - 0.8);
    const r     = rodRadius * 0.55;
    const m     = new THREE.Mesh(protonGeom, protonMat);
    m.position.set(xPos, r * Math.cos(theta), r * Math.sin(theta));
    rodGroup.add(m);
  }

  // ── 物理（回転のみ）─────────────────────────────────────────────────
  // 慣性モーメント: 円盤 I = ½mr²  (m=10, r=4)
  const INERTIA  = 0.5 * 10.0 * 4.0 * 4.0;
  const ANG_DAMP = 3.0; // [1/s] 指数減衰

  let angle  = initialAngle;
  let omega  = 0;
  let accTau = 0;

  // 外力を積算（作用点からトルクを計算）
  function addForce(fx, fz, appPx, appPz) {
    accTau += (appPz - FIXED_PZ) * fx - (appPx - FIXED_PX) * fz;
  }

  // 棒軸に沿った代表電荷3点（ワールド座標）
  // rotation.y = θ のとき ローカルX軸 → ワールド (cos θ, 0, sin θ)
  function getChargePoints() {
    const cy   = baseY + 0.70;
    const dx   = Math.cos(angle), dz = -Math.sin(angle); // rotation.y=θ → +X端は (cosθ, 0, -sinθ)
    const half = rodAxisHalf * 0.65; // ≈ 2.275
    return [
      new THREE.Vector3(FIXED_PX - half * dx, cy, FIXED_PZ - half * dz),
      new THREE.Vector3(FIXED_PX,             cy, FIXED_PZ             ),
      new THREE.Vector3(FIXED_PX + half * dx, cy, FIXED_PZ + half * dz),
    ];
  }

  function update(dt) {
    if (!root.visible) { accTau = 0; return; }
    omega  += (accTau / INERTIA) * dt;
    angle  += omega * dt;
    omega  *= Math.exp(-ANG_DAMP * dt);
    spinGroup.rotation.y = angle;
    accTau = 0;
  }

  root.userData.update          = update;
  root.userData.addForce        = addForce;
  root.userData.getChargePoints = getChargePoints;

  return root;
}
