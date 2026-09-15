import * as THREE from 'three';

// ── ナトリウム原子モデル（Bohr 模型風）──────────────────────────────────
// createSodiumAtomModel({ position, animateElectrons, autoRotate })
//   → THREE.Group  ※ userData.update(dt) を毎フレーム呼ぶこと

// ===== 核子パッキング =====
function packNucleons(count, minDist) {
  const pos = [];
  const phi0 = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = phi0 * i;
    const scale = minDist * 1.2 * Math.cbrt((i + 1) / count);
    pos.push({ x: Math.cos(theta) * r * scale, y: y * scale, z: Math.sin(theta) * r * scale });
  }
  for (let iter = 0; iter < 1500; iter++) {
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y, dz = pos[j].z - pos[i].z;
        const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (d < minDist && d > 1e-5) {
          const push = (minDist - d) * 0.5;
          const nx = dx/d, ny = dy/d, nz = dz/d;
          pos[i].x -= nx*push; pos[i].y -= ny*push; pos[i].z -= nz*push;
          pos[j].x += nx*push; pos[j].y += ny*push; pos[j].z += nz*push;
        }
      }
    }
    for (let i = 0; i < count; i++) { pos[i].x *= 0.978; pos[i].y *= 0.978; pos[i].z *= 0.978; }
  }
  const targetR = minDist * 1.05;
  for (let smooth = 0; smooth < 300; smooth++) {
    for (let i = 0; i < count; i++) {
      const d = Math.sqrt(pos[i].x**2 + pos[i].y**2 + pos[i].z**2);
      if (d > targetR) {
        const k = (targetR + (d - targetR) * 0.92) / d;
        pos[i].x *= k; pos[i].y *= k; pos[i].z *= k;
      }
    }
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y, dz = pos[j].z - pos[i].z;
        const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (d < minDist && d > 1e-5) {
          const push = (minDist - d) * 0.5;
          const nx = dx/d, ny = dy/d, nz = dz/d;
          pos[i].x -= nx*push; pos[i].y -= ny*push; pos[i].z -= nz*push;
          pos[j].x += nx*push; pos[j].y += ny*push; pos[j].z += nz*push;
        }
      }
    }
  }
  return pos;
}

// ===== シェル定義（K=2, L=8, M=1）=====
const SHELL_DEFS = [
  { radius: 3.4, count: 2, speed: 0.825, axis: [0.94, 0, 0.34],   turns: 1 },
  { radius: 5.9, count: 8, speed: 0.49,  axis: [-0.17, 0, 0.98],  turns: 1 },
  { radius: 8.6, count: 1, speed: 0.3,   axis: [-0.77, 0, -0.64], turns: 1 },
];

const CYCLE_TOTAL  = 15;  // 秒
const CYCLE_STILL  = 10;  // 静止フェーズ
const CYCLE_ROTATE = 5;   // 回転フェーズ

export function createSodiumAtomModel({ position = [0, 0, 0], animateElectrons = true } = {}) {
  const root = new THREE.Group();
  root.position.set(...position);

  // ── マテリアル ──────────────────────────────────────────────────────
  const protonMat  = new THREE.MeshPhongMaterial({ color: 0xe63946, specular: 0x553333, shininess: 35 });
  const neutronMat = new THREE.MeshPhongMaterial({ color: 0x2a4fb0, specular: 0x334466, shininess: 30 });
  const electronMat = new THREE.MeshPhongMaterial({ color: 0x7fd47a, specular: 0x446644, shininess: 45 });
  const orbitMat   = new THREE.LineBasicMaterial({ color: 0xbfc3c8, transparent: true, opacity: 0.85 });

  // ── 原子核 ─────────────────────────────────────────────────────────
  const nucleusGroup = new THREE.Group();
  root.add(nucleusGroup);

  const nucleonRadius = 0.52;
  const packed = packNucleons(23, nucleonRadius * 1.55);
  // シャッフル（proton/neutron の色混在）
  for (let i = packed.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [packed[i], packed[j]] = [packed[j], packed[i]];
  }

  const nucleonGeom = new THREE.SphereGeometry(nucleonRadius, 32, 24);
  for (let i = 0; i < packed.length; i++) {
    const mesh = new THREE.Mesh(nucleonGeom, i < 11 ? protonMat : neutronMat);
    mesh.position.set(packed[i].x, packed[i].y, packed[i].z);
    nucleusGroup.add(mesh);
  }

  // ── 電子殻 ─────────────────────────────────────────────────────────
  const electronGeom = new THREE.SphereGeometry(0.27, 24, 18);
  const shellData = [];

  SHELL_DEFS.forEach((def) => {
    const group = new THREE.Group();
    root.add(group);

    // 軌道リング
    const segs = 360;
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push(Math.cos(a) * def.radius, 0, Math.sin(a) * def.radius);
    }
    const ringGeom = new THREE.BufferGeometry();
    ringGeom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    group.add(new THREE.Line(ringGeom, orbitMat));

    // 電子
    const electrons = [];
    for (let i = 0; i < def.count; i++) {
      const mesh = new THREE.Mesh(electronGeom, electronMat);
      mesh.userData.phase = (i / def.count) * Math.PI * 2;
      group.add(mesh);
      electrons.push(mesh);
    }

    const axisVec = new THREE.Vector3(...def.axis).normalize();
    shellData.push({ group, electrons, speed: def.speed, radius: def.radius, axisVec, turns: def.turns });
  });

  // ── アニメーション ─────────────────────────────────────────────────
  let t = 0;
  const _quat = new THREE.Quaternion();

  root.userData.update = function update(dt) {
    if (!animateElectrons) return;
    t += dt;

    // 原子核の緩やかな回転
    nucleusGroup.rotation.y = t * 0.28;
    nucleusGroup.rotation.x = Math.sin(t * 0.35) * 0.25;
    nucleusGroup.rotation.z = Math.cos(t * 0.22) * 0.15;

    // 殻の回転サイクル（10秒静止 + 5秒回転）
    const cyclePos = t % CYCLE_TOTAL;
    let progress;
    if (cyclePos < CYCLE_STILL) {
      progress = 0;
    } else {
      const tRot = cyclePos - CYCLE_STILL;
      progress = 0.5 * (1 - Math.cos(Math.PI * tRot / CYCLE_ROTATE));
    }

    shellData.forEach(({ group, electrons, speed, radius, axisVec, turns }) => {
      const angle = progress * Math.PI * 2 * turns;
      _quat.setFromAxisAngle(axisVec, angle);
      group.quaternion.copy(_quat);

      electrons.forEach(mesh => {
        if (mesh.userData.grabbed) return; // ドラッグ中はアニメーション停止
        const a = mesh.userData.phase + t * speed;
        mesh.position.set(Math.cos(a) * radius, 0, Math.sin(a) * radius);
      });
    });
  };

  // ── M殻電子へのアクセス ─────────────────────────────────────────────
  const mShellData = shellData[2];
  root.userData.mShellElectrons = mShellData.electrons;
  root.userData.mShellGroup     = mShellData.group;

  root.userData.mShellRadius = SHELL_DEFS[2].radius;

  root.userData.removeMShellElectron = function (mesh) {
    const idx = mShellData.electrons.indexOf(mesh);
    if (idx !== -1) mShellData.electrons.splice(idx, 1);
  };

  root.userData.addExternalElectron = function (mesh) {
    mShellData.group.add(mesh);
    mShellData.electrons.push(mesh);
    mShellData.electrons.forEach((e, i) => {
      e.userData.phase = (i / mShellData.electrons.length) * Math.PI * 2;
    });
    mesh.userData.grabbed = false;
  };

  return root;
}
