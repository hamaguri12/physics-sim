import * as THREE from 'three';

// ── ドラッグできる帯電ガラス棒（陽子12個・電子なし）────────────────────
// createChargedRodProbe({ position, camera })
//   → { group, getChargePoints, tryDrag, updateDrag, releaseDrag,
//        isDragging, checkHover }
//
// ガラス棒と布でこすった後の帯電ガラス棒を想定。
// XZ 平面上を自由にドラッグして回転台に近づけると斥力が働く。

export function createChargedRodProbe({ position = [0, 0, 0], camera } = {}) {
  const group = new THREE.Group();
  group.position.set(...position);

  const rodLen  = 7.0;
  const rodRad  = 0.45;
  const rodHalf = rodLen * 0.5;

  // ── ガラス棒（charging-simulation.js と同一マテリアル）──────────────
  const rodMat = new THREE.MeshPhongMaterial({
    color: 0xd0e4ff, specular: 0xffffff, shininess: 220,
    transparent: true, opacity: 0.28, side: THREE.DoubleSide,
  });
  const coreMat = new THREE.MeshPhongMaterial({
    color: 0xeaf3ff, specular: 0xffffff, shininess: 320,
    transparent: true, opacity: 0.11, side: THREE.DoubleSide,
  });
  const rodGeom = new THREE.CylinderGeometry(rodRad, rodRad, rodLen, 72, 1);
  rodGeom.rotateZ(Math.PI / 2);
  group.add(new THREE.Mesh(rodGeom, rodMat));

  const coreGeom = new THREE.CylinderGeometry(rodRad * 0.82, rodRad * 0.82, rodLen * 0.999, 48, 1);
  coreGeom.rotateZ(Math.PI / 2);
  group.add(new THREE.Mesh(coreGeom, coreMat));

  // 陽子 12 個
  const protonMat = new THREE.MeshPhongMaterial({ color: 0xe63946, specular: 0x553333, shininess: 35 });
  for (let i = 0; i < 12; i++) {
    const theta = i * 2.39996;
    const xPos  = ((i + 0.5) / 12 - 0.5) * (rodLen - 0.8);
    const r     = rodRad * 0.55;
    const m     = new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 18), protonMat);
    m.position.set(xPos, r * Math.cos(theta), r * Math.sin(theta));
    group.add(m);
  }

  // 当たり判定用 不可視シリンダー（棒より少し太い）
  const hitGeom = new THREE.CylinderGeometry(rodRad + 0.45, rodRad + 0.45, rodLen, 24, 1);
  hitGeom.rotateZ(Math.PI / 2);
  const hitMesh = new THREE.Mesh(hitGeom, new THREE.MeshBasicMaterial({ visible: false }));
  group.add(hitMesh);

  // ── 電荷座標（棒軸3点、ワールド座標）───────────────────────────────
  // プローブは常に X 軸方向を向く（回転なし）
  function getChargePoints() {
    const half = rodHalf * 0.65;
    const y    = group.position.y;
    return [
      new THREE.Vector3(group.position.x - half, y, group.position.z),
      new THREE.Vector3(group.position.x,         y, group.position.z),
      new THREE.Vector3(group.position.x + half,  y, group.position.z),
    ];
  }

  // ── ドラッグ（XZ 平面上）────────────────────────────────────────────
  const _rc  = new THREE.Raycaster();
  const _mn  = new THREE.Vector2();
  const _hp  = new THREE.Vector3();
  const _dp  = new THREE.Plane();
  const _off = new THREE.Vector3();
  let dragging = false;

  function setNDC(cx, cy) {
    _mn.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
  }

  function tryDrag(cx, cy) {
    if (!group.visible || !camera) return false;
    setNDC(cx, cy);
    _rc.setFromCamera(_mn, camera);
    const hits = _rc.intersectObject(hitMesh, false);
    if (!hits.length) return false;
    const hp = hits[0].point;
    _off.set(group.position.x - hp.x, 0, group.position.z - hp.z);
    _dp.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), hp);
    dragging = true;
    return true;
  }

  function updateDrag(cx, cy) {
    if (!dragging || !camera) return;
    setNDC(cx, cy);
    _rc.setFromCamera(_mn, camera);
    if (_rc.ray.intersectPlane(_dp, _hp)) {
      group.position.x = _hp.x + _off.x;
      group.position.z = _hp.z + _off.z;
    }
  }

  function releaseDrag() { dragging = false; }

  function checkHover(cx, cy) {
    if (!group.visible || !camera) return false;
    setNDC(cx, cy);
    _rc.setFromCamera(_mn, camera);
    return _rc.intersectObject(hitMesh, false).length > 0;
  }

  return {
    group,
    getChargePoints,
    tryDrag,
    updateDrag,
    releaseDrag,
    isDragging: () => dragging,
    checkHover,
  };
}
