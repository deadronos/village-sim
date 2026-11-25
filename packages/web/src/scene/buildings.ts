import type { PlaceNode, Weather } from "@village/core";
import * as THREE from "three/webgpu";
import { createLowPolyPine } from "./terrain.ts";

export interface AnimatedBuildings {
  group: THREE.Group;
  update(dt: number, elapsed: number, duskFactor: number, weather: Weather): void;
}

function makeLabelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(15, 23, 35, 0.78)";
  ctx.beginPath();
  ctx.roundRect(14, 12, 228, 40, 18);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = "#f2f6fb";
  ctx.font = "600 22px Inter, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 33);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.scale.set(4.1, 1.02, 1);
  return sprite;
}

function mat(
  color: number,
  roughness = 0.85,
  extra?: Partial<THREE.MeshStandardMaterialParameters>,
) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    flatShading: true,
    ...extra,
  });
}

export function buildVillageBuildings(places: readonly PlaceNode[]): AnimatedBuildings {
  const group = new THREE.Group();
  group.name = "village-buildings";

  const windowMats: THREE.MeshStandardMaterial[] = [];
  const lanternLights: THREE.PointLight[] = [];
  const smokePuffs: Array<{ mesh: THREE.Mesh; offset: number; base: THREE.Vector3 }> = [];
  let windmillBlades: THREE.Group | null = null;
  let forgeLight: THREE.PointLight | null = null;
  let forgeEmberMat: THREE.MeshStandardMaterial | null = null;
  const wheatTufts: THREE.Mesh[] = [];

  const createGlowWindowMat = () => {
    const m = new THREE.MeshStandardMaterial({
      color: 0x3b4d63,
      emissive: 0xffb347,
      emissiveIntensity: 0.1,
      roughness: 0.4,
      flatShading: true,
    });
    windowMats.push(m);
    return m;
  };

  const cottageRoofColors = [
    0xc96b4b, 0x5c7c89, 0xb8894c, 0x8a5b6a, 0x678a61, 0x9b6446, 0x596b8c, 0xc78d52,
  ];
  let cottageIdx = 0;

  for (const place of places) {
    const container = new THREE.Group();
    container.position.set(place.x, 0, place.z);
    container.name = `place-${place.id}`;

    switch (place.kind) {
      case "well": {
        const stoneRing = new THREE.Mesh(
          new THREE.CylinderGeometry(1.15, 1.3, 0.95, 8),
          mat(0x9a9c9e, 0.92),
        );
        stoneRing.position.y = 0.48;
        stoneRing.castShadow = true;
        stoneRing.receiveShadow = true;
        container.add(stoneRing);

        const water = new THREE.Mesh(
          new THREE.CylinderGeometry(0.88, 0.88, 0.1, 8),
          mat(0x3ba6d8, 0.2, { metalness: 0.2 }),
        );
        water.position.y = 0.72;
        container.add(water);

        const woodMat = mat(0x734a2d);
        for (const sx of [-0.95, 0.95]) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.2, 0.18), woodMat);
          post.position.set(sx, 1.5, 0);
          post.castShadow = true;
          container.add(post);
        }
        const roof = new THREE.Mesh(new THREE.ConeGeometry(1.7, 1.1, 4), mat(0xa8553b));
        roof.position.y = 2.95;
        roof.rotation.y = Math.PI / 4;
        roof.castShadow = true;
        container.add(roof);

        const light = new THREE.PointLight(0xffbe6b, 0, 12);
        light.position.set(0, 2.4, 0);
        container.add(light);
        lanternLights.push(light);

        const label = makeLabelSprite("Village Well");
        label.position.set(0, 4.4, 0);
        container.add(label);
        break;
      }

      case "bakery": {
        const body = new THREE.Mesh(new THREE.BoxGeometry(3.8, 2.5, 3.2), mat(0xf2e3c9));
        body.position.y = 1.25;
        body.castShadow = true;
        body.receiveShadow = true;
        container.add(body);

        const roof = new THREE.Mesh(new THREE.ConeGeometry(3.15, 1.9, 4), mat(0xc75a3c));
        roof.position.y = 3.45;
        roof.rotation.y = Math.PI / 4;
        roof.castShadow = true;
        container.add(roof);

        // Chimney + animated low-poly smoke puffs
        const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.65, 2.2, 0.65), mat(0x8c5646));
        chimney.position.set(1.1, 3.3, -0.7);
        chimney.castShadow = true;
        container.add(chimney);

        const smokeMat = mat(0xe6ecf2, 0.95, { transparent: true, opacity: 0.72 });
        for (let i = 0; i < 4; i++) {
          const puff = new THREE.Mesh(new THREE.DodecahedronGeometry(0.32, 0), smokeMat);
          const base = new THREE.Vector3(1.1, 4.5, -0.7);
          puff.position.copy(base);
          container.add(puff);
          smokePuffs.push({ mesh: puff, offset: i * 0.25, base });
        }

        // Warm windows & front awning + bread loaves
        const winMat = createGlowWindowMat();
        const win = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.8, 0.12), winMat);
        win.position.set(-0.85, 1.4, 1.62);
        container.add(win);

        const door = new THREE.Mesh(new THREE.BoxGeometry(0.85, 1.4, 0.14), mat(0x6d452c));
        door.position.set(0.75, 0.7, 1.62);
        container.add(door);

        const counter = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.65), mat(0x8c5c39));
        counter.position.set(-0.8, 0.3, 2.15);
        counter.castShadow = true;
        container.add(counter);

        const loafMat = mat(0xd99b43);
        for (const lx of [-1.15, -0.8, -0.45]) {
          const loaf = new THREE.Mesh(new THREE.DodecahedronGeometry(0.18, 0), loafMat);
          loaf.scale.set(1.3, 0.75, 0.85);
          loaf.position.set(lx, 0.7, 2.15);
          container.add(loaf);
        }

        const light = new THREE.PointLight(0xffb45c, 0, 11);
        light.position.set(0, 2.2, 2.4);
        container.add(light);
        lanternLights.push(light);

        const label = makeLabelSprite("Anna's Bakery");
        label.position.set(0, 5.5, 0);
        container.add(label);
        break;
      }

      case "tavern": {
        const lower = new THREE.Mesh(new THREE.BoxGeometry(4.8, 2.4, 3.8), mat(0xdcc9ac));
        lower.position.y = 1.2;
        lower.castShadow = true;
        lower.receiveShadow = true;
        container.add(lower);

        const upper = new THREE.Mesh(new THREE.BoxGeometry(5.1, 1.6, 4.1), mat(0xe8d9bf));
        upper.position.y = 3.1;
        upper.castShadow = true;
        container.add(upper);

        const roof = new THREE.Mesh(new THREE.ConeGeometry(4.1, 2.2, 4), mat(0x61443a));
        roof.position.y = 4.95;
        roof.rotation.y = Math.PI / 4;
        roof.castShadow = true;
        container.add(roof);

        // Timber framing & warm windows
        const winMat = createGlowWindowMat();
        for (const wx of [-1.4, 1.4]) {
          const w1 = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.85, 0.14), winMat);
          w1.position.set(wx, 1.35, 1.92);
          container.add(w1);

          const w2 = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.75, 0.14), winMat);
          w2.position.set(wx, 3.1, 2.08);
          container.add(w2);
        }

        const door = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.6, 0.16), mat(0x5c3621));
        door.position.set(0, 0.8, 1.92);
        container.add(door);

        // Tavern barrel outside
        const barrel = new THREE.Mesh(
          new THREE.CylinderGeometry(0.38, 0.36, 0.85, 8),
          mat(0x7c4c2b),
        );
        barrel.position.set(2.8, 0.43, 1.5);
        barrel.castShadow = true;
        container.add(barrel);

        const light = new THREE.PointLight(0xffa947, 0, 14);
        light.position.set(0, 2.4, 2.7);
        container.add(light);
        lanternLights.push(light);

        const label = makeLabelSprite("Bram's Tavern");
        label.position.set(0, 6.9, 0);
        container.add(label);
        break;
      }

      case "market": {
        const stallConfigs = [
          { x: -1.7, z: -0.4, awning: 0xc94a4a },
          { x: 1.7, z: -0.4, awning: 0x3b76b0 },
        ];
        const woodMat = mat(0x7e5334);
        for (const sc of stallConfigs) {
          const table = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.75, 1.1), woodMat);
          table.position.set(sc.x, 0.38, sc.z);
          table.castShadow = true;
          container.add(table);

          for (const px of [-0.95, 0.95]) {
            const pole = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.1, 0.12), woodMat);
            pole.position.set(sc.x + px, 1.05, sc.z - 0.45);
            container.add(pole);
          }

          const awning = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.16, 1.5), mat(sc.awning));
          awning.position.set(sc.x, 2.15, sc.z + 0.05);
          awning.rotation.x = 0.22;
          awning.castShadow = true;
          container.add(awning);
        }

        const label = makeLabelSprite("Market Square");
        label.position.set(0, 3.6, 0);
        container.add(label);
        break;
      }

      case "smithy": {
        const shop = new THREE.Mesh(new THREE.BoxGeometry(3.9, 2.3, 3.2), mat(0x6e6a67));
        shop.position.y = 1.15;
        shop.castShadow = true;
        shop.receiveShadow = true;
        container.add(shop);

        const roof = new THREE.Mesh(new THREE.ConeGeometry(3.2, 1.7, 4), mat(0x3f434a));
        roof.position.y = 3.15;
        roof.rotation.y = Math.PI / 4;
        roof.castShadow = true;
        container.add(roof);

        // Glowing outdoor forge hearth + anvil
        const hearth = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.9, 1.1), mat(0x524f4e));
        hearth.position.set(-2.4, 0.45, 0.7);
        hearth.castShadow = true;
        container.add(hearth);

        forgeEmberMat = new THREE.MeshStandardMaterial({
          color: 0xff6a1a,
          emissive: 0xff5500,
          emissiveIntensity: 1.8,
          roughness: 0.4,
          flatShading: true,
        });
        const embers = new THREE.Mesh(new THREE.DodecahedronGeometry(0.42, 0), forgeEmberMat);
        embers.scale.set(1.2, 0.6, 1);
        embers.position.set(-2.4, 0.95, 0.7);
        container.add(embers);

        const anvil = new THREE.Mesh(
          new THREE.BoxGeometry(0.75, 0.55, 0.42),
          mat(0x2f343b, 0.5, { metalness: 0.7 }),
        );
        anvil.position.set(-1.3, 0.28, 1.8);
        anvil.castShadow = true;
        container.add(anvil);

        forgeLight = new THREE.PointLight(0xff7426, 2.2, 10);
        forgeLight.position.set(-2.4, 1.7, 0.9);
        container.add(forgeLight);

        const label = makeLabelSprite("Torin's Smithy");
        label.position.set(0, 4.9, 0);
        container.add(label);
        break;
      }

      case "fields": {
        // Plowed earth field + swaying low-poly golden wheat rows + rustic windmill
        const soil = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.14, 5.4), mat(0x7c5b3b));
        soil.position.set(0, 0.06, 0.4);
        soil.receiveShadow = true;
        container.add(soil);

        const wheatMat = mat(0xe3b84c);
        for (let r = -2; r <= 2; r++) {
          for (let c = -3; c <= 3; c++) {
            const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.32, 1.05, 5), wheatMat);
            tuft.position.set(c * 0.95, 0.62, 0.4 + r * 0.95);
            tuft.rotation.y = (r + c) * 0.7;
            tuft.castShadow = true;
            container.add(tuft);
            wheatTufts.push(tuft);
          }
        }

        // Rustic windmill tower beside the field
        const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.45, 4.2, 7), mat(0xdfd3be));
        tower.position.set(-2.8, 2.1, -2.9);
        tower.castShadow = true;
        container.add(tower);

        const cap = new THREE.Mesh(new THREE.ConeGeometry(1.15, 1.1, 7), mat(0x9a4d36));
        cap.position.set(-2.8, 4.7, -2.9);
        cap.castShadow = true;
        container.add(cap);

        windmillBlades = new THREE.Group();
        windmillBlades.position.set(-2.8, 3.6, -1.85);
        const sailMat = mat(0xf6efe1);
        const sparMat = mat(0x6b4428);
        for (let b = 0; b < 4; b++) {
          const arm = new THREE.Group();
          arm.rotation.z = (b * Math.PI) / 2;
          const spar = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.2, 0.12), sparMat);
          spar.position.y = 1.1;
          arm.add(spar);
          const sail = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.65, 0.06), sailMat);
          sail.position.set(0.28, 1.35, 0.02);
          arm.add(sail);
          windmillBlades.add(arm);
        }
        container.add(windmillBlades);

        const label = makeLabelSprite("Wheat Fields");
        label.position.set(0, 5.7, -1.2);
        container.add(label);
        break;
      }

      case "woods": {
        const trunkMat = mat(0x6b452d);
        const pineMatA = mat(0x285c3b);
        const pineMatB = mat(0x387447);
        const offsets = [
          [-2.2, -1.6, 1.25],
          [2.1, -1.8, 1.35],
          [2.6, 1.4, 1.15],
          [-1.9, 2.1, 1.1],
          [0.5, -2.8, 1.4],
        ] as const;

        for (let i = 0; i < offsets.length; i++) {
          const [ox, oz, sc] = offsets[i]!;
          const tree = createLowPolyPine(trunkMat, i % 2 === 0 ? pineMatA : pineMatB, sc);
          tree.position.set(ox, 0, oz);
          container.add(tree);
        }

        // Stacked timber logs & chopping stump
        const logMat = mat(0x8c5b37);
        for (let i = 0; i < 3; i++) {
          const log = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 2.1, 7), logMat);
          log.rotation.z = Math.PI / 2;
          log.position.set(0, 0.22 + (i === 2 ? 0.34 : 0), i === 2 ? 0.25 : i * 0.48);
          log.castShadow = true;
          container.add(log);
        }

        const label = makeLabelSprite("Pine Woods");
        label.position.set(0, 5.2, 0);
        container.add(label);
        break;
      }

      case "garden": {
        const bedMat = mat(0x7c5335);
        const herbMats = [mat(0x8e6ec8), mat(0x479e72), mat(0x6db35d)];
        for (let row = 0; row < 2; row++) {
          const bed = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.38, 1.25), bedMat);
          bed.position.set(0, 0.19, row === 0 ? -1.0 : 1.0);
          bed.castShadow = true;
          bed.receiveShadow = true;
          container.add(bed);

          for (let h = -2; h <= 2; h++) {
            const bush = new THREE.Mesh(
              new THREE.DodecahedronGeometry(0.32, 0),
              herbMats[(Math.abs(h) + row) % herbMats.length]!,
            );
            bush.position.set(h * 0.68, 0.56, row === 0 ? -1.0 : 1.0);
            bush.castShadow = true;
            container.add(bush);
          }
        }

        // Cozy garden greenhouse / trellis arch
        const archMat = mat(0x9a7554);
        for (const ax of [-1.2, 1.2]) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.1, 0.14), archMat);
          post.position.set(ax, 1.05, 0);
          container.add(post);
        }
        const beam = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.16, 0.3), archMat);
        beam.position.set(0, 2.15, 0);
        container.add(beam);

        const label = makeLabelSprite("Herb Garden");
        label.position.set(0, 3.6, 0);
        container.add(label);
        break;
      }

      case "home": {
        const roofColor = cottageRoofColors[cottageIdx % cottageRoofColors.length]!;
        cottageIdx += 1;

        const cottage = new THREE.Mesh(new THREE.BoxGeometry(2.5, 1.8, 2.2), mat(0xefe4d0));
        cottage.position.y = 0.9;
        cottage.castShadow = true;
        cottage.receiveShadow = true;
        container.add(cottage);

        const roof = new THREE.Mesh(new THREE.ConeGeometry(2.15, 1.45, 4), mat(roofColor));
        roof.position.y = 2.52;
        roof.rotation.y = Math.PI / 4;
        roof.castShadow = true;
        container.add(roof);

        const winMat = createGlowWindowMat();
        const win = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.1), winMat);
        win.position.set(-0.55, 1.0, 1.12);
        container.add(win);

        const door = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.05, 0.12), mat(0x6e472d));
        door.position.set(0.45, 0.52, 1.12);
        container.add(door);

        // Face cottages loosely toward the central well
        container.rotation.y = Math.atan2(-place.x, -place.z);
        break;
      }
    }

    group.add(container);
  }

  return {
    group,
    update(dt: number, elapsed: number, duskFactor: number, weather: Weather) {
      // Spin windmill faster when breezy or raining
      if (windmillBlades) {
        const spinSpeed = weather === "breezy" ? 1.85 : weather === "rain" ? 1.35 : 0.72;
        windmillBlades.rotation.z -= dt * spinSpeed;
      }

      // Gentle wheat sway
      const swayAmp = weather === "breezy" ? 0.14 : 0.05;
      for (let i = 0; i < wheatTufts.length; i++) {
        wheatTufts[i]!.rotation.z = Math.sin(elapsed * 2.2 + i * 0.45) * swayAmp;
      }

      // Rising bakery chimney smoke puffs
      for (const puff of smokePuffs) {
        const phase = (elapsed * 0.28 + puff.offset) % 1;
        puff.mesh.position.set(
          puff.base.x + Math.sin(elapsed + puff.offset * 6) * 0.22,
          puff.base.y + phase * 2.4,
          puff.base.z + phase * 0.4,
        );
        const s = 0.65 + phase * 1.1;
        puff.mesh.scale.setScalar(s);
      }

      // Flickering smithy forge glow
      if (forgeLight && forgeEmberMat) {
        const flicker = 1.6 + Math.sin(elapsed * 11) * 0.35 + Math.cos(elapsed * 17) * 0.2;
        forgeLight.intensity = flicker + duskFactor * 1.4;
        forgeEmberMat.emissiveIntensity = 1.3 + Math.sin(elapsed * 9) * 0.35;
      }

      // Warm cottage & landmark windows + street lanterns at sunset/twilight
      const windowGlow = 0.12 + duskFactor * 1.65;
      for (const m of windowMats) {
        m.emissiveIntensity = windowGlow;
      }
      for (const l of lanternLights) {
        l.intensity = duskFactor * 3.8;
      }
    },
  };
}
