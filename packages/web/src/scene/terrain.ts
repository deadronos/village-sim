import type { PlaceEdge, PlaceNode } from "@village/core";
import * as THREE from "three/webgpu";

function seededNoise(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Builds the low-poly faceted floating village island, cobblestone road graph
 * along VILLAGE_EDGES, brook pond, pine groves, rocks, and flower tufts.
 */
export function buildVillageTerrain(
  places: readonly PlaceNode[],
  edges: readonly PlaceEdge[],
): THREE.Group {
  const group = new THREE.Group();
  group.name = "village-terrain";

  // 1. Floating low-poly meadow island top
  const islandGeo = new THREE.CylinderGeometry(31, 29.5, 2.2, 24, 3);
  const posAttr = islandGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < posAttr.count; i++) {
    const vx = posAttr.getX(i);
    const vy = posAttr.getY(i);
    const vz = posAttr.getZ(i);
    const dist = Math.hypot(vx, vz);

    if (vy > 0.5 && dist > 16) {
      // Gentle rolling hillside around the village rim
      const bump = (seededNoise(vx * 0.25, vz * 0.25) - 0.5) * 0.7;
      posAttr.setY(i, vy + bump);
    } else if (vy < -0.5) {
      // Organic rocky perimeter wobble
      const wobble = (seededNoise(vx * 0.4, vz * 0.4) - 0.5) * 1.6;
      posAttr.setX(i, vx + (vx / Math.max(1, dist)) * wobble);
      posAttr.setZ(i, vz + (vz / Math.max(1, dist)) * wobble);
    }
  }
  islandGeo.computeVertexNormals();

  const grassMat = new THREE.MeshStandardMaterial({
    color: 0x6ea657,
    roughness: 0.92,
    metalness: 0.02,
    flatShading: true,
  });
  const grassMesh = new THREE.Mesh(islandGeo, grassMat);
  grassMesh.position.y = -1.1;
  grassMesh.receiveShadow = true;
  group.add(grassMesh);

  // Rocky cliff underside of floating diorama
  const underGeo = new THREE.ConeGeometry(29.2, 8.5, 16, 2);
  const underPos = underGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < underPos.count; i++) {
    const vx = underPos.getX(i);
    const vy = underPos.getY(i);
    const vz = underPos.getZ(i);
    const jitter = (seededNoise(vx * 0.5 + vy, vz * 0.5) - 0.5) * 1.4;
    underPos.setX(i, vx + jitter * 0.45);
    underPos.setZ(i, vz + jitter * 0.45);
  }
  underGeo.computeVertexNormals();
  const rockMat = new THREE.MeshStandardMaterial({
    color: 0x6c5b4b,
    roughness: 0.95,
    flatShading: true,
  });
  const underMesh = new THREE.Mesh(underGeo, rockMat);
  underMesh.rotation.x = Math.PI;
  underMesh.position.y = -6.4;
  group.add(underMesh);

  // Central village plaza cobblestones around the well
  const plazaGeo = new THREE.CylinderGeometry(4.6, 4.9, 0.14, 10);
  const plazaMat = new THREE.MeshStandardMaterial({
    color: 0xb7a994,
    roughness: 0.9,
    flatShading: true,
  });
  const plaza = new THREE.Mesh(plazaGeo, plazaMat);
  plaza.position.set(0, 0.04, 0);
  plaza.receiveShadow = true;
  group.add(plaza);

  // 2. Cobblestone / dirt road network matching every edge in VILLAGE_EDGES
  const placeMap = new Map(places.map((p) => [p.id, p]));
  const roadMat = new THREE.MeshStandardMaterial({
    color: 0xc2ab85,
    roughness: 0.94,
    flatShading: true,
  });
  const stoneMat = new THREE.MeshStandardMaterial({
    color: 0xa29687,
    roughness: 0.9,
    flatShading: true,
  });

  for (const edge of edges) {
    const a = placeMap.get(edge.from);
    const b = placeMap.get(edge.to);
    if (!a || !b) continue;

    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const angle = Math.atan2(dx, dz);

    const isCottageLane = a.kind === "home" || b.kind === "home";
    const width = isCottageLane ? 0.95 : 1.45;
    const roadGeo = new THREE.BoxGeometry(width, 0.08, len);
    const road = new THREE.Mesh(roadGeo, roadMat);
    road.position.set((a.x + b.x) / 2, 0.03, (a.z + b.z) / 2);
    road.rotation.y = angle;
    road.receiveShadow = true;
    group.add(road);

    // Stepping stone accents along main roads
    const steps = Math.max(2, Math.floor(len / 2.4));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const sx = a.x + dx * t + (seededNoise(s * 3.1, len) - 0.5) * 0.35;
      const sz = a.z + dz * t + (seededNoise(len, s * 2.7) - 0.5) * 0.35;
      const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(0.24, 0), stoneMat);
      stone.scale.set(1.2, 0.25, 0.9);
      stone.position.set(sx, 0.07, sz);
      stone.rotation.y = s * 1.1;
      stone.receiveShadow = true;
      group.add(stone);
    }
  }

  // 3. Shimmering low-poly village pond in the south meadow
  const pondGeo = new THREE.CylinderGeometry(4.4, 4.1, 0.12, 9);
  const pondMat = new THREE.MeshStandardMaterial({
    color: 0x4ca9cf,
    roughness: 0.18,
    metalness: 0.15,
    flatShading: true,
  });
  const pond = new THREE.Mesh(pondGeo, pondMat);
  pond.scale.set(1.25, 1, 0.8);
  pond.position.set(4.5, 0.03, 17.5);
  pond.receiveShadow = true;
  group.add(pond);

  // 4. Perimeter stylized pine trees, boulders, and wildflowers (avoiding places & roads)
  const trunkMat = new THREE.MeshStandardMaterial({
    color: 0x6f4a32,
    roughness: 0.9,
    flatShading: true,
  });
  const pineColors = [0x2f6a44, 0x3b7b4e, 0x4b8a54, 0x2a5a3c];
  const pineMats = pineColors.map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, flatShading: true }),
  );
  const boulderMat = new THREE.MeshStandardMaterial({
    color: 0x8b8e93,
    roughness: 0.9,
    flatShading: true,
  });
  const flowerColors = [0xffcf56, 0xf27d9b, 0xfff5d6, 0x8fb8ff];
  const flowerMats = flowerColors.map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, flatShading: true }),
  );

  const isNearLandmark = (x: number, z: number, pad = 4.2): boolean => {
    if (Math.hypot(x - 4.5, z - 17.5) < 5.5) return true;
    for (const p of places) {
      if (Math.hypot(x - p.x, z - p.z) < pad) return true;
    }
    return false;
  };

  for (let i = 0; i < 48; i++) {
    const angle = (i / 48) * Math.PI * 2 + seededNoise(i, 7) * 0.25;
    const radius = 19 + seededNoise(i * 2.3, 13) * 8.8;
    const tx = Math.cos(angle) * radius;
    const tz = Math.sin(angle) * radius;
    if (isNearLandmark(tx, tz, 4.4)) continue;

    const tree = createLowPolyPine(
      trunkMat,
      pineMats[i % pineMats.length]!,
      0.85 + seededNoise(i, 31) * 0.65,
    );
    tree.position.set(tx, 0, tz);
    tree.rotation.y = seededNoise(i, 91) * Math.PI * 2;
    group.add(tree);
  }

  for (let i = 0; i < 16; i++) {
    const angle = seededNoise(i, 53) * Math.PI * 2;
    const radius = 12 + seededNoise(i, 71) * 14;
    const rx = Math.cos(angle) * radius;
    const rz = Math.sin(angle) * radius;
    if (isNearLandmark(rx, rz, 3.6)) continue;

    const rock = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.45 + seededNoise(i, 19) * 0.55, 0),
      boulderMat,
    );
    rock.scale.set(1.2, 0.7, 1);
    rock.position.set(rx, 0.22, rz);
    rock.rotation.set(seededNoise(i, 1), seededNoise(i, 2), seededNoise(i, 3));
    rock.castShadow = true;
    rock.receiveShadow = true;
    group.add(rock);
  }

  for (let i = 0; i < 28; i++) {
    const angle = seededNoise(i, 107) * Math.PI * 2;
    const radius = 5 + seededNoise(i, 113) * 18;
    const fx = Math.cos(angle) * radius;
    const fz = Math.sin(angle) * radius;
    if (isNearLandmark(fx, fz, 2.8)) continue;

    const flower = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.16, 0),
      flowerMats[i % flowerMats.length]!,
    );
    flower.position.set(fx, 0.14, fz);
    group.add(flower);
  }

  return group;
}

export function createLowPolyPine(
  trunkMat: THREE.Material,
  foliageMat: THREE.Material,
  scale = 1,
): THREE.Group {
  const tree = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 1.1, 6), trunkMat);
  trunk.position.y = 0.55;
  trunk.castShadow = true;
  tree.add(trunk);

  const cone1 = new THREE.Mesh(new THREE.ConeGeometry(1.15, 1.8, 7), foliageMat);
  cone1.position.y = 1.65;
  cone1.castShadow = true;
  tree.add(cone1);

  const cone2 = new THREE.Mesh(new THREE.ConeGeometry(0.85, 1.5, 7), foliageMat);
  cone2.position.y = 2.55;
  cone2.castShadow = true;
  tree.add(cone2);

  const cone3 = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.1, 6), foliageMat);
  cone3.position.y = 3.3;
  cone3.castShadow = true;
  tree.add(cone3);

  tree.scale.setScalar(scale);
  return tree;
}
