/**
 * oxygen-atom-model.js  （v4 — 軌道歳差運動）
 *
 * v3 からの変更点（動きのみ、見た目は v2/v3 と同一）:
 *
 *  【アーキテクチャ変更】
 *   v3: inner/outer それぞれを固定ベース ± sin 小揺れ
 *   v4: 共通親 orbitSystemGroup が球面座標で連続歳差
 *       その上で inner / outer に小さなローカルオフセット
 *
 *  【歳差の仕組み】
 *   軌道平面の法線ベクトルを球面座標で定義し、
 *   方位角 φ(t) = AZIMUTH_SPEED * t + INITIAL_AZIMUTH を一定速度で進める。
 *   極角 θ(t) = BASE_POLAR + POLAR_AMP * sin(POLAR_SPEED * t) でゆっくり増減。
 *
 *   方位角と極角の周期を互いに素の比（12s / 18s）にすることで、
 *   Lissajous 的な軌跡となり毎周「少し違う見え方」を繰り返す。
 *
 *  【inner / outer の差】
 *   両者は同じ orbitSystemGroup を親に持ち、
 *   それぞれ小さな逆位相 sin オフセットを局所回転として持つ。
 *   sin = 0 のとき収束（ほぼ同一平面）、ピーク時に少し開く。
 */

import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// 原子核（v2 と同一）
// ─────────────────────────────────────────────────────────────────────────────
const NUCLEON_POS = [
  [ 0.00,  0.00,  0.00],
  [ 0.15,  0.07, -0.05],
  [-0.14,  0.09,  0.07],
  [ 0.04, -0.15,  0.10],
  [-0.06,  0.03,  0.19],
  [ 0.19, -0.07,  0.12],
  [-0.07,  0.19,  0.10],
  [ 0.09, -0.03, -0.19],
  [-0.19, -0.10, -0.08],
  [ 0.09,  0.20, -0.08],
  [ 0.21,  0.09,  0.08],
  [-0.21,  0.05,  0.10],
  [ 0.06, -0.20, -0.07],
  [-0.04,  0.03, -0.22],
  [ 0.18, -0.14, -0.08],
  [-0.12,  0.16, -0.16],
];
const NUCLEON_TYPES = [0,1,0,1,1,0,1,0,1,0,1,0,0,1,0,1]; // 0=陽子, 1=中性子

// ─────────────────────────────────────────────────────────────────────────────
// 軌道アニメーション定数
//
// 【共通平面の歳差運動】
//   方位角 φ = ORBIT_AZIMUTH_SPEED * t + ORBIT_INITIAL_AZIMUTH  （一定速度で進む）
//   極角   θ = ORBIT_BASE_POLAR + ORBIT_POLAR_AMPLITUDE * sin(ORBIT_POLAR_SPEED * t)
//
//   法線ベクトル（Y 軸を極軸とした球面座標）:
//     n = ( sin(θ)·cos(φ),  cos(θ),  sin(θ)·sin(φ) )
//
//   θ → 0 に近いとき : n ≈ (0, 1, 0) → 水平リング → 「横長楕円」
//   θ → π/2 のとき  : n は水平面内 → 縦向きリング → 「円・縦寄り楕円」
//
// 【周期の設定】
//   ORBIT_PRECESSION_PERIOD = 12 秒 → 方位角 1 周 = 12 秒
//   ORBIT_POLAR_SPEED 周期  = 18 秒 → 方位角と異なる周期でLissajous的な多様な軌跡
//   →「長時間同じ姿勢に留まらず、かつ全体として一巡する」挙動
//
// 【極角の範囲】
//   ORBIT_BASE_POLAR ± ORBIT_POLAR_AMPLITUDE = 0.78 ± 0.60 rad
//   → 0.18 rad (10°) ～ 1.38 rad (79°)
//   → 横向き薄楕円 〜 縦寄り・正面寄りの変化域
// ─────────────────────────────────────────────────────────────────────────────

const ORBIT_PRECESSION_PERIOD = 12;                              // 秒
const ORBIT_AZIMUTH_SPEED     = (2 * Math.PI) / ORBIT_PRECESSION_PERIOD;
const ORBIT_BASE_POLAR        = 0.78;                            // rad
const ORBIT_POLAR_AMPLITUDE   = 0.60;                            // rad
const ORBIT_POLAR_SPEED       = (2 * Math.PI) / (ORBIT_PRECESSION_PERIOD * 1.5); // 18秒周期
const ORBIT_INITIAL_AZIMUTH   = -Math.PI / 2;                   // t=0 の初期方位角

// ─── 分離アニメーション（同平面 → 分離 → 同平面の周期運動）──────────────
//
//   sep(t) = sin(SEP_SPEED * t)
//   t = 0, T/2, T, ... のとき sep = 0 → 両リングが完全同一平面に収束
//   t = T/4, 3T/4, ... のとき sep = ±1 → 最大分離
//
//   inner は主に X 軸まわりへ、outer は主に Z 軸まわりへ開く
//   → 異なる軸方向に分離するため視覚的コントラストが明確
//
//   SEP_PERIOD = 8秒 → 同平面への収束は 4秒おき（T/2 = 4秒）
//   ※歳差周期（12秒）と意図的に異なる → 独立した分離リズム
//
const SEP_PERIOD = 8;                       // 秒（1サイクル）
const SEP_SPEED  = (2 * Math.PI) / SEP_PERIOD;

// inner の分離回転量（主に X 軸、補助で Z 軸）
const INNER_SEP_X =  0.18;  // rad ← 主成分。大きくすると分離が目立つ
const INNER_SEP_Z =  0.06;  // rad ← 補助。方向に立体感を加える

// outer の分離回転量（主に Z 軸、補助で -X 軸 → inner と明確に異なる方向）
const OUTER_SEP_X = -0.06;  // rad ← inner と逆符号で方向を変える
const OUTER_SEP_Z =  0.16;  // rad ← 主成分

// ─────────────────────────────────────────────────────────────────────────────
// スケール基準値（v2 と同一）
// ─────────────────────────────────────────────────────────────────────────────
const OUTER_R    = 1.65;
const INNER_R    = 1.10;
const ELECTRON_R = 0.058;
const NUCLEON_R  = 0.15;
const ORBIT_TUBE = 0.007;

// カラー定義（v2 と同一）
const COL_PROTON   = new THREE.Color('#d81b3a');
const COL_NEUTRON  = new THREE.Color('#5a6eea');
const COL_ELECTRON = new THREE.Color('#68d064');
const COL_ORBIT    = new THREE.Color('#cacdd0');

// トーラスのデフォルト法線（TorusGeometry はデフォルトで XY 平面 → 法線 = Z）
const _TORUS_DEFAULT_NORMAL = new THREE.Vector3(0, 0, 1);

// リング面上の角度 theta → 3D 座標
function orbitPoint(q, radius, theta) {
  return new THREE.Vector3(
    Math.cos(theta) * radius,
    Math.sin(theta) * radius,
    0
  ).applyQuaternion(q);
}

// ─────────────────────────────────────────────────────────────────────────────
// createOxygenAtomModel
// ─────────────────────────────────────────────────────────────────────────────
export function createOxygenAtomModel({
  position         = [0, 0, 0],
  rotation         = [0, 0, 0],
  scale            = 1,
  autoRotate       = false,
  animateElectrons = false,
  orbitOpacity     = 0.26,
  electronScale    = 1,
  nucleusScale     = 1,
} = {}) {

  const root = new THREE.Group();
  root.position.set(...position);
  root.rotation.set(...rotation);
  root.scale.setScalar(typeof scale === 'number' ? scale : 1);

  // ── 共有ジオメトリ ────────────────────────────────────────────────────────
  const nucleonGeo  = new THREE.SphereGeometry(NUCLEON_R  * nucleusScale,  18, 12);
  const electronGeo = new THREE.SphereGeometry(ELECTRON_R * electronScale, 14, 10);

  // ─────────────────────────────────────────────────────────────────────────
  // 1. 原子核（v2 と同一）
  // ─────────────────────────────────────────────────────────────────────────
  const nucleusGroup = new THREE.Group();
  nucleusGroup.rotation.set(0.15, 0.22, 0.08);
  root.add(nucleusGroup);

  const protonMat  = new THREE.MeshStandardMaterial({ color: COL_PROTON,  roughness: 0.30, metalness: 0.0 });
  const neutronMat = new THREE.MeshStandardMaterial({ color: COL_NEUTRON, roughness: 0.30, metalness: 0.0 });

  NUCLEON_POS.forEach((p, i) => {
    const mesh = new THREE.Mesh(nucleonGeo, NUCLEON_TYPES[i] === 0 ? protonMat : neutronMat);
    mesh.position.set(p[0], p[1], p[2]);
    nucleusGroup.add(mesh);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. 軌道線（v4: 2段構造）
  //    root
  //    └── orbitSystemGroup  ← 球面歳差で動かす
  //        ├── innerLocalGroup  ← 小さなローカルオフセット
  //        │   └── innerTorus
  //        └── outerLocalGroup
  //            └── outerTorus
  // ─────────────────────────────────────────────────────────────────────────
  const orbitMat = new THREE.MeshBasicMaterial({
    color:      COL_ORBIT,
    transparent: true,
    opacity:    orbitOpacity,
    depthWrite: false,
    side:       THREE.DoubleSide,
  });

  const orbitSystemGroup = new THREE.Group();
  root.add(orbitSystemGroup);

  const innerLocalGroup = new THREE.Group();
  orbitSystemGroup.add(innerLocalGroup);
  innerLocalGroup.add(new THREE.Mesh(new THREE.TorusGeometry(INNER_R, ORBIT_TUBE, 8, 128), orbitMat));

  const outerLocalGroup = new THREE.Group();
  orbitSystemGroup.add(outerLocalGroup);
  outerLocalGroup.add(new THREE.Mesh(new THREE.TorusGeometry(OUTER_R, ORBIT_TUBE, 8, 128), orbitMat));

  // ─────────────────────────────────────────────────────────────────────────
  // 3. 電子（初期位置は t=0 の orbitSystemGroup 姿勢で計算）
  // ─────────────────────────────────────────────────────────────────────────
  const electronMat = new THREE.MeshStandardMaterial({
    color:             COL_ELECTRON,
    roughness:         0.35,
    metalness:         0.0,
    emissive:          COL_ELECTRON,
    emissiveIntensity: 0.10,
  });

  // t=0 の法線ベクトル → 初期 orbitSystemGroup 姿勢
  const _initNormal = new THREE.Vector3(
    Math.sin(ORBIT_BASE_POLAR) * Math.cos(ORBIT_INITIAL_AZIMUTH),
    Math.cos(ORBIT_BASE_POLAR),
    Math.sin(ORBIT_BASE_POLAR) * Math.sin(ORBIT_INITIAL_AZIMUTH)
  );
  const _initQ = new THREE.Quaternion().setFromUnitVectors(_TORUS_DEFAULT_NORMAL, _initNormal);

  const INNER_BASE = [0, Math.PI];
  const innerMeshes = INNER_BASE.map(theta => {
    const mesh = new THREE.Mesh(electronGeo, electronMat);
    mesh.position.copy(orbitPoint(_initQ, INNER_R, theta));
    root.add(mesh);
    return mesh;
  });

  const OUTER_BASE = Array.from({ length: 6 }, (_, i) => (i / 6) * Math.PI * 2);
  const outerMeshes = OUTER_BASE.map(theta => {
    const mesh = new THREE.Mesh(electronGeo, electronMat);
    mesh.position.copy(orbitPoint(_initQ, OUTER_R, theta));
    root.add(mesh);
    return mesh;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. アニメーション（フレームごとに呼ぶ）
  // ─────────────────────────────────────────────────────────────────────────
  let t          = 0;
  let innerPhase = 0;
  let outerPhase = 0;

  const INNER_ELECTRON_SPEED = 0.20;  // rad/s
  const OUTER_ELECTRON_SPEED = 0.11;  // rad/s
  const AUTO_ROT_Y           = 0.10;  // rad/s
  const AUTO_ROT_X           = 0.03;  // rad/s

  // フレームごとに再利用するテンポラリオブジェクト（GC 削減）
  const _orbitNormal     = new THREE.Vector3();
  const _orbitQ          = new THREE.Quaternion();
  const _innerLocalEuler = new THREE.Euler();
  const _innerLocalQ     = new THREE.Quaternion();
  const _outerLocalEuler = new THREE.Euler();
  const _outerLocalQ     = new THREE.Quaternion();
  const _innerWorldQ     = new THREE.Quaternion();
  const _outerWorldQ     = new THREE.Quaternion();

  root.userData.update = function update(dt) {
    t += dt;

    // ── 共通平面の歳差運動 ────────────────────────────────────────────────
    //
    //   法線の球面座標（Y 軸を極軸）:
    //     φ: 方位角  = AZIMUTH_SPEED * t + INITIAL_AZIMUTH  ← 一定速度で一周
    //     θ: 極角    = BASE_POLAR + AMP * sin(POLAR_SPEED * t) ← 緩やかに増減
    //
    //   setFromUnitVectors(Z, n): トーラスの法線(Z)をnへ向ける quaternion
    //
    const azimuth = ORBIT_AZIMUTH_SPEED * t + ORBIT_INITIAL_AZIMUTH;
    const polar   = ORBIT_BASE_POLAR + ORBIT_POLAR_AMPLITUDE * Math.sin(ORBIT_POLAR_SPEED * t);

    _orbitNormal.set(
      Math.sin(polar) * Math.cos(azimuth),
      Math.cos(polar),
      Math.sin(polar) * Math.sin(azimuth)
    );
    _orbitQ.setFromUnitVectors(_TORUS_DEFAULT_NORMAL, _orbitNormal);
    orbitSystemGroup.quaternion.copy(_orbitQ);

    // ── inner / outer の分離アニメーション ───────────────────────────────
    //
    //   s = sin(SEP_SPEED * t) — 両者が同じ s を使うことで、
    //   s = 0 のタイミング（周期の 0, T/2, T, …）で必ず同一平面に収束し、
    //   s = ±1 のタイミングで最大に開く。
    //   inner は X 軸主体、outer は Z 軸主体で開くため、
    //   収束・乖離が視覚的に明確になる。
    //
    const s = Math.sin(SEP_SPEED * t);

    _innerLocalEuler.set(INNER_SEP_X * s, 0, INNER_SEP_Z * s);
    _innerLocalQ.setFromEuler(_innerLocalEuler);
    innerLocalGroup.quaternion.copy(_innerLocalQ);

    _outerLocalEuler.set(OUTER_SEP_X * s, 0, OUTER_SEP_Z * s);
    _outerLocalQ.setFromEuler(_outerLocalEuler);
    outerLocalGroup.quaternion.copy(_outerLocalQ);

    // ── 電子位置を軌道平面に追従させる ──────────────────────────────────
    //
    //   電子は root 直下に配置されているため、世界空間での位置が必要。
    //   world quaternion = orbitSystemGroup.Q × localGroup.Q
    //
    _innerWorldQ.multiplyQuaternions(_orbitQ, _innerLocalQ);
    _outerWorldQ.multiplyQuaternions(_orbitQ, _outerLocalQ);

    if (animateElectrons) {
      innerPhase += INNER_ELECTRON_SPEED * dt;
      outerPhase += OUTER_ELECTRON_SPEED * dt;
    }

    innerMeshes.forEach((mesh, i) => {
      mesh.position.copy(orbitPoint(_innerWorldQ, INNER_R, INNER_BASE[i] + innerPhase));
    });
    outerMeshes.forEach((mesh, i) => {
      mesh.position.copy(orbitPoint(_outerWorldQ, OUTER_R, OUTER_BASE[i] + outerPhase));
    });

    // ── グループ自動回転 ─────────────────────────────────────────────────
    if (autoRotate) {
      root.rotation.y += AUTO_ROT_Y * dt;
      root.rotation.x += AUTO_ROT_X * dt;
    }
  };

  return root;
}
