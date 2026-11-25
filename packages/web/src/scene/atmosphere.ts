import type { Weather } from "@village/core";
import * as THREE from "three/webgpu";

export interface AtmosphereController {
  duskFactor: number;
  update(dt: number, simHour: number, weather: Weather): void;
}

const SKY_DAWN = new THREE.Color(0x52658c);
const SKY_DAY = new THREE.Color(0x74b3dc);
const SKY_SUNSET = new THREE.Color(0x8e5d6b);
const SKY_NIGHT = new THREE.Color(0x162238);
const SKY_RAIN = new THREE.Color(0x3a4b5e);

const SUN_DAWN = new THREE.Color(0xffb47d);
const SUN_DAY = new THREE.Color(0xfff4df);
const SUN_SUNSET = new THREE.Color(0xff8c5a);
const SUN_NIGHT = new THREE.Color(0x7da4e8);

export function createVillageAtmosphere(scene: THREE.Scene): AtmosphereController {
  const skyColor = new THREE.Color(SKY_DAY);
  scene.background = skyColor;
  scene.fog = new THREE.FogExp2(skyColor.getHex(), 0.0085);

  const hemiLight = new THREE.HemisphereLight(0xd9ecff, 0x3b4d36, 0.95);
  scene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0xfff4df, 2.1);
  sunLight.position.set(22, 34, 18);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.near = 4;
  sunLight.shadow.camera.far = 95;
  sunLight.shadow.camera.left = -36;
  sunLight.shadow.camera.right = 36;
  sunLight.shadow.camera.top = 36;
  sunLight.shadow.camera.bottom = -36;
  sunLight.shadow.bias = -0.0005;
  scene.add(sunLight);

  // Stylized low-poly rain streaks (toggled visible during rain weather)
  const rainCount = 320;
  const rainGroup = new THREE.Group();
  const rainGeo = new THREE.BoxGeometry(0.05, 0.85, 0.05);
  const rainMat = new THREE.MeshBasicMaterial({
    color: 0xaad2f5,
    transparent: true,
    opacity: 0.55,
  });
  const drops: THREE.Mesh[] = [];
  for (let i = 0; i < rainCount; i++) {
    const drop = new THREE.Mesh(rainGeo, rainMat);
    drop.position.set(
      (Math.random() - 0.5) * 60,
      Math.random() * 26 + 2,
      (Math.random() - 0.5) * 60,
    );
    rainGroup.add(drop);
    drops.push(drop);
  }
  rainGroup.visible = false;
  scene.add(rainGroup);

  const targetSky = new THREE.Color();
  const targetSun = new THREE.Color();

  const controller: AtmosphereController = {
    duskFactor: 0,
    update(dt: number, simHour: number, weather: Weather) {
      // Map 06:00..22:00 across a daylight arc
      const dayT = Math.max(0, Math.min(1, (simHour - 6) / 16));
      const sunAngle = dayT * Math.PI;
      const sunY = Math.max(5, Math.sin(sunAngle) * 34);
      const sunX = -Math.cos(sunAngle) * 32;
      sunLight.position.set(sunX, sunY, 16);

      // Compute sky/sun tint across dawn -> noon -> golden hour -> twilight
      if (simHour < 8.5) {
        const k = Math.max(0, (simHour - 6) / 2.5);
        targetSky.copy(SKY_DAWN).lerp(SKY_DAY, k);
        targetSun.copy(SUN_DAWN).lerp(SUN_DAY, k);
        controller.duskFactor = (1 - k) * 0.55;
      } else if (simHour < 16.5) {
        targetSky.copy(SKY_DAY);
        targetSun.copy(SUN_DAY);
        controller.duskFactor = 0;
      } else if (simHour < 19.5) {
        const k = (simHour - 16.5) / 3.0;
        targetSky.copy(SKY_DAY).lerp(SKY_SUNSET, k);
        targetSun.copy(SUN_DAY).lerp(SUN_SUNSET, k);
        controller.duskFactor = k * 0.72;
      } else {
        const k = Math.min(1, (simHour - 19.5) / 2.5);
        targetSky.copy(SKY_SUNSET).lerp(SKY_NIGHT, k);
        targetSun.copy(SUN_SUNSET).lerp(SUN_NIGHT, k);
        controller.duskFactor = 0.72 + k * 0.28;
      }

      if (weather === "rain") {
        targetSky.lerp(SKY_RAIN, 0.55);
      } else if (weather === "overcast") {
        targetSky.lerp(SKY_RAIN, 0.28);
      }

      skyColor.lerp(targetSky, Math.min(1, dt * 3));
      (scene.fog as THREE.FogExp2).color.copy(skyColor);
      sunLight.color.lerp(targetSun, Math.min(1, dt * 3));

      const weatherDim = weather === "rain" ? 0.65 : weather === "overcast" ? 0.82 : 1;
      sunLight.intensity = (2.15 - controller.duskFactor * 1.45) * weatherDim;
      hemiLight.intensity = (0.98 - controller.duskFactor * 0.5) * weatherDim;

      rainGroup.visible = weather === "rain";
      if (rainGroup.visible) {
        for (const drop of drops) {
          drop.position.y -= dt * 24;
          if (drop.position.y < 0.2) {
            drop.position.y = 24 + Math.random() * 4;
          }
        }
      }
    },
  };

  return controller;
}
