import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Tube, RoundedBox, Text, Instance, Instances, Html } from '@react-three/drei';
import * as THREE from 'three';

// --- 1. Python実行エンジン ---
function usePythonEngine() {
  const [pinStates, setPinStates] = useState({});
  const [ready, setReady] = useState(false);
  const [logs, setLogs] = useState([]);
  const pyodideRef = useRef(null);
  const isRunningRef = useRef(false);

  useEffect(() => {
    const init = async () => {
      if (window.loadPyodide && !pyodideRef.current) {
        try {
          const py = await window.loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.23.4/full/" });
          pyodideRef.current = py;
          window.picoPinUpdate = (pin, state) => { if (isRunningRef.current) setPinStates(prev => ({ ...prev, [pin]: state })); };
          window.picoLog = (msg) => { if (isRunningRef.current) setLogs(prev => [...prev, "> " + msg]); };
          py.setStdout({ batched: (msg) => { if (isRunningRef.current) setLogs(prev => [...prev, msg]) }});
          setReady(true);
        } catch (e) { console.error(e); }
      }
    };
    init();
  }, []);

  const run = async (inputCode) => {
    if (!pyodideRef.current) return;
    isRunningRef.current = true;
    setPinStates({});
    setLogs([">>> 実行開始"]);
    let transformedCode = inputCode.replace(/time\.sleep\(/g, "await asyncio.sleep(");
    const header = "import asyncio\nimport time\n"; 
    const shim = `
import js
class Pin:
    OUT = "OUT"
    IN = "IN"
    def __init__(self, pin, mode=OUT): 
        self.pin = pin
        self.mode = mode
    def value(self, val):
        js.window.picoPinUpdate(self.pin, val == 1)
def print(*args):
    msg = " ".join(map(str, args))
    js.window.picoLog(msg)
`;
    try {
      await pyodideRef.current.runPythonAsync(shim + "\n" + header + transformedCode);
      if (isRunningRef.current) setLogs(prev => [...prev, ">>> 実行終了"]);
    } catch (err) {
      if (isRunningRef.current) setLogs(prev => [...prev, "Error: " + err.message]);
    }
  };

  const stop = () => {
    isRunningRef.current = false;
    setPinStates({});
    setLogs(prev => [...prev, ">>> 停止 (リセット)"]);
  };

  return { pinStates, ready, logs, run, stop, isRunning: isRunningRef.current };
}

// --- 2. 座標 & 物理定数 ---
const PITCH = 0.254;
const ROW_COUNT = 30;
const GAP_CENTER = 0.762;

// ★改良: 電源レール対応の座標計算
// Col 0, -1: 左電源レール / Col 11, 12: 右電源レール
function getHolePos(row, col) {
  const zOffset = -((ROW_COUNT - 1) * PITCH) / 2;
  const z = zOffset + (row - 1) * PITCH;
  let x = 0;

  if (col >= 1 && col <= 5) { // Main Left
    x = -(0.3 + (5 - col) * PITCH);
  } else if (col >= 6 && col <= 10) { // Main Right
    x = (0.3 + (col - 6) * PITCH);
  } else if (col === 0) { // Power L Inner (+)
    x = -2.0;
  } else if (col === -1) { // Power L Outer (-)
    x = -2.3;
  } else if (col === 11) { // Power R Inner (+)
    x = 2.0;
  } else if (col === 12) { // Power R Outer (-)
    x = 2.3;
  }
  return [x, 0.15, z];
}

// 穴ID生成 (電源レール対応)
function getHoleId(row, col) {
  if (col === 0) return `PL+-${row}`; // Power Left +
  if (col === -1) return `PL--${row}`; // Power Left -
  if (col === 11) return `PR+-${row}`; // Power Right +
  if (col === 12) return `PR--${row}`; // Power Right -
  
  const side = col <= 5 ? 'L' : 'R';
  return `${side}-${row}`;
}

// PicoのGNDピン定義 (Row番号)
const GND_ROWS = [3, 8, 13, 18, 23, 28]; 

function getGpioFromHole(row, col) {
  if (col < 1 || col > 10) return null; // 電源レールにはPico刺さらない
  if (col <= 5) {
    const leftMap = { 1:0, 2:1, 4:2, 5:3, 6:4, 7:5, 9:6, 10:7, 11:8, 12:9, 14:10, 15:11, 16:12, 17:13, 19:14, 20:15 };
    return leftMap[row] !== undefined ? leftMap[row] : null;
  } else {
    const rightMap = { 20:16, 19:17, 17:18, 16:19, 15:20, 14:21, 12:22, 10:26, 9:27, 7:28 };
    return rightMap[row] !== undefined ? rightMap[row] : null;
  }
}

// --- 3. 3D部品 ---
function Tooltip({ position, text }) {
  return (
    <Html position={position} style={{ pointerEvents: 'none' }}>
      <div style={{ background: 'rgba(0,0,0,0.85)', color: '#0f0', padding: '6px 10px', borderRadius: '6px', fontSize: '14px', fontFamily: 'monospace', whiteSpace: 'pre-wrap', transform: 'translate3d(-50%, -150%, 0)', border: '1px solid #444', boxShadow: '0 4px 6px rgba(0,0,0,0.3)' }}>
        {text}
      </div>
    </Html>
  );
}

function Electron({ path, speed = 0.5, offset = 0, reverse = false }) {
  const meshRef = useRef();
  const progress = useRef(offset);
  const color = useMemo(() => new THREE.Color('#ffff00'), []);

  useFrame((state, delta) => {
    if (!meshRef.current || !path) return;
    progress.current += speed * delta;
    if (progress.current > 1) progress.current -= 1;
    const t = reverse ? 1.0 - progress.current : progress.current;
    meshRef.current.position.copy(path.getPointAt(t));
  });
  return <mesh ref={meshRef}><sphereGeometry args={[0.04]} /><meshBasicMaterial color={color} toneMapped={false}/></mesh>;
}

function useComponentPath(start, end, height) {
  return useMemo(() => {
    const pStart = new THREE.Vector3(...start);
    const pEnd = new THREE.Vector3(...end);
    const sink = 0.3;
    const points = [
      pStart.clone().setY(pStart.y - sink),
      pStart,
      pStart.clone().setY(height),
      pEnd.clone().setY(height),
      pEnd,
      pEnd.clone().setY(pEnd.y - sink)
    ];
    return new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.05);
  }, [start, end, height]);
}

function ResistorComponent({ item, setHoverInfo, hasCurrent }) {
  const { sR, sC, eR, eC, scale, ohms = 330, name } = item;
  const start = getHolePos(sR, sC);
  const end = getHolePos(eR, eC);
  const height = 0.4 * scale;
  const path = useComponentPath(start, end, height);
  const mid = new THREE.Vector3(...start).add(new THREE.Vector3(...end)).multiplyScalar(0.5).setY(height);
  const direction = new THREE.Vector3(...end).sub(new THREE.Vector3(...start));
  const angleY = Math.atan2(direction.x, direction.z) + Math.PI / 2;
  const legRadius = 0.015 * scale;
  
  const tooltipText = `[${name || 'Res'}]\n${ohms}Ω`;

  return (
    <group 
      onPointerOver={(e) => { e.stopPropagation(); setHoverInfo({ pos: mid, text: tooltipText }); }}
      onPointerOut={() => setHoverInfo(null)}
    >
      <group position={mid} rotation={[0, angleY, 0]} scale={[scale, scale, scale]}>
        <mesh rotation={[0,0,Math.PI/2]}><cylinderGeometry args={[0.12, 0.12, 0.6]} /><meshStandardMaterial color="#e0c0a0" /></mesh>
        <mesh rotation={[0,0,Math.PI/2]} position={[0.15, 0, 0]}><cylinderGeometry args={[0.125, 0.125, 0.05]} /><meshStandardMaterial color="brown" /></mesh>
        <mesh rotation={[0,0,Math.PI/2]} position={[0.05, 0, 0]}><cylinderGeometry args={[0.125, 0.125, 0.05]} /><meshStandardMaterial color="black" /></mesh>
        <mesh rotation={[0,0,Math.PI/2]} position={[-0.05, 0, 0]}><cylinderGeometry args={[0.125, 0.125, 0.05]} /><meshStandardMaterial color="red" /></mesh>
        <mesh rotation={[0,0,Math.PI/2]} position={[-0.2, 0, 0]}><cylinderGeometry args={[0.125, 0.125, 0.05]} /><meshStandardMaterial color="gold" metalness={0.8} /></mesh>
      </group>
      <Tube args={[path, 64, legRadius, 8, false]}><meshStandardMaterial color="silver" metalness={0.8} roughness={0.2} /></Tube>
      {hasCurrent && [0, 0.2, 0.4, 0.6, 0.8].map(i => <Electron key={i} path={path} offset={i} />)}
    </group>
  );
}

function LEDComponent({ item, setHoverInfo, hasCurrent }) {
  const { sR, sC, eR, eC, name } = item;
  const start = getHolePos(sR, sC);
  const end = getHolePos(eR, eC);
  const height = 0.5;
  const path = useComponentPath(start, end, height);
  const mid = new THREE.Vector3(...start).add(new THREE.Vector3(...end)).multiplyScalar(0.5).setY(height + 0.1); 
  const tooltipText = `[${name || 'LED'}]`;

  return (
    <group
      onPointerOver={(e) => { e.stopPropagation(); setHoverInfo({ pos: mid, text: tooltipText }); }}
      onPointerOut={() => setHoverInfo(null)}
    >
      <group position={mid}>
        <mesh position={[0, 0.2, 0]}><sphereGeometry args={[0.18, 32, 16, 0, Math.PI * 2, 0, Math.PI/2]} /><meshStandardMaterial color={hasCurrent ? "#ff0000" : "#aa0000"} emissive={hasCurrent ? "#ff0000" : "#000"} emissiveIntensity={hasCurrent ? 2 : 0} transparent opacity={0.9} roughness={0.1}/></mesh>
        <mesh position={[0, 0.05, 0]}><cylinderGeometry args={[0.18, 0.18, 0.3]} /><meshStandardMaterial color={hasCurrent ? "#ff0000" : "#aa0000"} emissive={hasCurrent ? "#ff0000" : "#000"} transparent opacity={0.9} /></mesh>
        <mesh position={[0, -0.1, 0]}><cylinderGeometry args={[0.2, 0.2, 0.05]} /><meshStandardMaterial color={hasCurrent ? "#ff0000" : "#aa0000"} transparent opacity={0.8} /></mesh>
      </group>
      <Tube args={[path, 64, 0.015, 8, false]}><meshStandardMaterial color="silver" metalness={0.8} roughness={0.2} /></Tube>
      {hasCurrent && [0, 0.2, 0.4, 0.6, 0.8].map(i => <Electron key={i} path={path} offset={i} />)}
    </group>
  );
}

function CleanWire({ item, setHoverInfo, hasCurrent }) {
  const { sR, sC, eR, eC, color: userColor, name } = item;
  const start = getHolePos(sR, sC);
  const end = getHolePos(eR, eC);
  const path = useMemo(() => {
    const pStart = new THREE.Vector3(...start); pStart.y += 0.15;
    const pEnd = new THREE.Vector3(...end); pEnd.y += 0.15;
    const points = [pStart, new THREE.Vector3(pStart.x, 0.5 + 2*0.2, pStart.z), new THREE.Vector3(pEnd.x, 0.5 + 2*0.2, pEnd.z), pEnd];
    return new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.1);
  }, [start, end]);

  const mid = path.getPointAt(0.5);
  const tooltipText = `[${name || 'Wire'}]`;

  return (
    <group 
      onPointerOver={(e) => { e.stopPropagation(); setHoverInfo({ pos: mid, text: tooltipText }); }}
      onPointerOut={() => setHoverInfo(null)}
    >
      <Tube args={[path, 64, 0.045, 8, false]}>
        <meshPhysicalMaterial color={userColor} transparent opacity={0.5} roughness={0.2} metalness={0.1} />
      </Tube>
      <mesh position={[start[0],0.1,start[2]]}><cylinderGeometry args={[0.025,0.025,0.4]}/><meshStandardMaterial color="#ccc"/></mesh>
      <mesh position={[end[0],0.1,end[2]]}><cylinderGeometry args={[0.025,0.025,0.4]}/><meshStandardMaterial color="#ccc"/></mesh>
      {hasCurrent && [0,0.2,0.4,0.6,0.8].map(i => <Electron key={i} path={path} offset={i} />)}
    </group>
  );
}

// ★改良: 電源レールの内部接続も含めた可視化
function BreadboardInternalFlow({ activeNodes, isSimulating }) {
  const lines = useMemo(() => {
    const flows = [];
    const activeRows = new Set();
    const powerLines = new Set();

    activeNodes.forEach(id => {
      if (id.startsWith('P')) { // 電源レール (PL+-, PR+-)
        // PL+-1 -> PL+ (列全体)
        const prefix = id.split('-')[0]; // PL+, PL-, PR+, PR-
        powerLines.add(prefix);
      } else {
        const [side, rowStr] = id.split('-');
        activeRows.add(`${side}-${parseInt(rowStr)}`);
      }
    });

    // メインエリアの横線
    activeRows.forEach(key => {
      const [side, rowStr] = key.split('-');
      const row = parseInt(rowStr);
      const startCol = side === 'L' ? 1 : 6;
      const endCol = side === 'L' ? 5 : 10;
      const startPos = getHolePos(row, startCol);
      const endPos = getHolePos(row, endCol);
      startPos[1] = 0.16; endPos[1] = 0.16;
      flows.push({ start: startPos, end: endPos, type: 'row' });
    });

    // 電源レールの縦線
    powerLines.forEach(prefix => { // PL+ など
      let col = 0;
      if (prefix === 'PL+') col = 0;
      else if (prefix === 'PL-') col = -1;
      else if (prefix === 'PR+') col = 11;
      else if (prefix === 'PR-') col = 12;
      
      const startPos = getHolePos(1, col);
      const endPos = getHolePos(30, col);
      startPos[1] = 0.16; endPos[1] = 0.16;
      flows.push({ start: startPos, end: endPos, type: 'col' });
    });

    return flows;
  }, [activeNodes]);

  if (!isSimulating) return null;

  return (
    <group>
      {lines.map((line, i) => {
        if (line.type === 'row') {
           return (
             <mesh key={i} rotation={[-Math.PI/2, 0, 0]} position={[(line.start[0]+line.end[0])/2, 0.155, line.start[2]]}>
               <planeGeometry args={[Math.abs(line.end[0] - line.start[0]), 0.15]} />
               <meshBasicMaterial color="#ffff00" transparent opacity={0.3} side={THREE.DoubleSide} />
             </mesh>
           );
        } else { // 電源レール (縦)
           return (
             <mesh key={i} rotation={[-Math.PI/2, 0, 0]} position={[line.start[0], 0.155, (line.start[2]+line.end[2])/2]}>
               <planeGeometry args={[0.15, Math.abs(line.end[2] - line.start[2])]} />
               <meshBasicMaterial color="#ffff00" transparent opacity={0.3} side={THREE.DoubleSide} />
             </mesh>
           );
        }
      })}
    </group>
  );
}

function Breadboard({ onHoleClick, selectedHole, draftStart, activeNodes, isSimulating }) {
  const holes = useMemo(() => {
    const temp = [];
    // Main
    for (let r=1; r<=ROW_COUNT; r++) {
      for (let c=1; c<=10; c++) temp.push({pos: getHolePos(r,c), r, c});
    }
    // Power Rails (Left: 0, -1 / Right: 11, 12)
    for (let r=1; r<=ROW_COUNT; r++) {
      temp.push({pos: getHolePos(r, 0), r, c: 0});
      temp.push({pos: getHolePos(r, -1), r, c: -1});
      temp.push({pos: getHolePos(r, 11), r, c: 11});
      temp.push({pos: getHolePos(r, 12), r, c: 12});
    }
    return temp;
  }, []);

  return (
    <group position={[0, -0.15, 0]}>
      {/* Main Board */}
      <RoundedBox args={[5.5, 0.3, ROW_COUNT*PITCH+0.5]} radius={0.1}><meshStandardMaterial color="#fff"/></RoundedBox>
      {/* Power Rails (Visual only) */}
      <mesh position={[-2.15, 0.16, 0]} rotation={[-Math.PI/2, 0, 0]}><planeGeometry args={[0.5, ROW_COUNT*PITCH]} /><meshBasicMaterial color="#f8f8f8" /></mesh>
      <mesh position={[2.15, 0.16, 0]} rotation={[-Math.PI/2, 0, 0]}><planeGeometry args={[0.5, ROW_COUNT*PITCH]} /><meshBasicMaterial color="#f8f8f8" /></mesh>
      {/* Lines */}
      <mesh position={[-2.0, 0.17, 0]} rotation={[-Math.PI/2, 0, 0]}><planeGeometry args={[0.05, ROW_COUNT*PITCH]} /><meshBasicMaterial color="red" /></mesh>
      <mesh position={[-2.3, 0.17, 0]} rotation={[-Math.PI/2, 0, 0]}><planeGeometry args={[0.05, ROW_COUNT*PITCH]} /><meshBasicMaterial color="blue" /></mesh>
      <mesh position={[2.0, 0.17, 0]} rotation={[-Math.PI/2, 0, 0]}><planeGeometry args={[0.05, ROW_COUNT*PITCH]} /><meshBasicMaterial color="red" /></mesh>
      <mesh position={[2.3, 0.17, 0]} rotation={[-Math.PI/2, 0, 0]}><planeGeometry args={[0.05, ROW_COUNT*PITCH]} /><meshBasicMaterial color="blue" /></mesh>

      <Instances range={holes.length}>
        <boxGeometry args={[0.12, 0.1, 0.12]} />
        <meshStandardMaterial color="#111" />
        {holes.map((h, i) => (<Instance key={i} position={[h.pos[0], 0.15, h.pos[2]]} onClick={(e) => { e.stopPropagation(); onHoleClick(h.r, h.c); }} />))}
      </Instances>
      
      {selectedHole && <mesh position={[getHolePos(selectedHole.row, selectedHole.col)[0], 0.16, getHolePos(selectedHole.row, selectedHole.col)[2]]} rotation={[-Math.PI/2, 0, 0]}><ringGeometry args={[0.08, 0.12, 32]} /><meshBasicMaterial color="yellow" side={THREE.DoubleSide} /></mesh>}
      {draftStart && <mesh position={[getHolePos(draftStart.row, draftStart.col)[0], 0.16, getHolePos(draftStart.row, draftStart.col)[2]]} rotation={[-Math.PI/2, 0, 0]}><ringGeometry args={[0.08, 0.12, 32]} /><meshBasicMaterial color="#00ffff" side={THREE.DoubleSide} /></mesh>}
      <BreadboardInternalFlow activeNodes={activeNodes} isSimulating={isSimulating} />
    </group>
  );
}

function Pico({ pinStates }) {
  const [, yRef, zRef] = getHolePos(1, 3);
  const isInternalLedOn = pinStates[25];
  const leftPins = [{name:"GP0",color:"#fff"},{name:"GP1",color:"#fff"},{name:"GND",color:"#000",bg:"#ccc"},{name:"GP2",color:"#fff"},{name:"GP3",color:"#fff"},{name:"GP4",color:"#fff"},{name:"GP5",color:"#fff"},{name:"GND",color:"#000",bg:"#ccc"},{name:"GP6",color:"#fff"},{name:"GP7",color:"#fff"},{name:"GP8",color:"#fff"},{name:"GP9",color:"#fff"},{name:"GND",color:"#000",bg:"#ccc"},{name:"GP10",color:"#fff"},{name:"GP11",color:"#fff"},{name:"GP12",color:"#fff"},{name:"GP13",color:"#fff"},{name:"GND",color:"#000",bg:"#ccc"},{name:"GP14",color:"#fff"},{name:"GP15",color:"#fff"}];
  const rightPins = [{name:"VBUS",color:"#ffcccc"},{name:"VSYS",color:"#ffcccc"},{name:"GND",color:"#000",bg:"#ccc"},{name:"3V3_EN",color:"#ffcccc"},{name:"3V3",color:"#ffcccc"},{name:"ADC_REF",color:"#ffcccc"},{name:"GP28",color:"#fff"},{name:"GND",color:"#000",bg:"#ccc"},{name:"GP27",color:"#fff"},{name:"GP26",color:"#fff"},{name:"RUN",color:"#ffcccc"},{name:"GP22",color:"#fff"},{name:"GND",color:"#000",bg:"#ccc"},{name:"GP21",color:"#fff"},{name:"GP20",color:"#fff"},{name:"GP19",color:"#fff"},{name:"GP18",color:"#fff"},{name:"GND",color:"#000",bg:"#ccc"},{name:"GP17",color:"#fff"},{name:"GP16",color:"#fff"}];
  return (
    <group position={[0, yRef+0.05, zRef+(19*PITCH)/2]}>
      <RoundedBox args={[2.1, 0.08, 5.2]} radius={0.05}><meshStandardMaterial color="#006600"/></RoundedBox>
      <mesh position={[0, 0.15, -2.4]}><boxGeometry args={[0.8, 0.25, 0.6]} /><meshStandardMaterial color="silver" /></mesh>
      <Text position={[0, 0.1, 0]} rotation={[-Math.PI/2, 0, 0]} fontSize={0.4}>RPi Pico</Text>
      <mesh position={[-0.4, 0.1, -1.8]}><boxGeometry args={[0.2, 0.05, 0.2]} /><meshStandardMaterial color={isInternalLedOn ? "#00ff00" : "#003300"} emissive={isInternalLedOn ? "#00ff00" : "#000"} /></mesh>
      <Text position={[-0.4, 0.11, -1.5]} rotation={[-Math.PI/2, 0, 0]} fontSize={0.15} color="white">LED</Text>
      {Array.from({ length: 20 }).map((_, i) => (
        <React.Fragment key={i}>
          <group position={[-0.889, -0.15, -2.413 + i * PITCH]}><mesh position={[0, 0.08, 0]}><boxGeometry args={[0.1, 0.1, 0.24]} /><meshStandardMaterial color="black" /></mesh><mesh position={[0, 0, 0]}><cylinderGeometry args={[0.03, 0.03, 0.5]} /><meshStandardMaterial color="gold" metalness={1} roughness={0.3} /></mesh><Text position={[-0.5, 0.21, 0]} rotation={[-Math.PI/2, 0, 0]} fontSize={0.12} color={leftPins[i].color} anchorX="right" outlineWidth={0.01} outlineColor="#003300">{leftPins[i].name}</Text></group>
          <group position={[0.889, -0.15, -2.413 + i * PITCH]}><mesh position={[0, 0.08, 0]}><boxGeometry args={[0.1, 0.1, 0.24]} /><meshStandardMaterial color="black" /></mesh><mesh position={[0, 0, 0]}><cylinderGeometry args={[0.03, 0.03, 0.5]} /><meshStandardMaterial color="gold" metalness={1} roughness={0.3} /></mesh><Text position={[0.5, 0.21, 0]} rotation={[-Math.PI/2, 0, 0]} fontSize={0.12} color={rightPins[i].color} anchorX="left" outlineWidth={0.01} outlineColor="#003300">{rightPins[i].name}</Text></group>
        </React.Fragment>
      ))}
    </group>
  );
}


// --- 4. メインアプリUI ---

export default function App() {
  const { pinStates, ready, logs, run, stop, isRunning } = usePythonEngine();
  const [leftPanelWidth, setLeftPanelWidth] = useState(500);
  const [editorHeight, setEditorHeight] = useState(400);
  const [hoverInfo, setHoverInfo] = useState(null);

  const [toolMode, setToolMode] = useState('cursor');
  const [draftStart, setDraftStart] = useState(null);
  const [editingId, setEditingId] = useState(null); 
  const [editType, setEditType] = useState(null); 

  // ★初期データ更新 (クリーンな状態)
  const [wires, setWires] = useState([
    { id: 1, sR: 20, sC: 2, eR: 25, eC: 2, color: "green", level: 2, name: "Wire 1" },
    { id: 2, sR: 28, sC: 10, eR: 18, eC: 10, color: "black", level: 1, name: "Wire 2" }
  ]);
  const [leds, setLeds] = useState([
    { id: 1, sR: 25, sC: 7, eR: 28, eC: 7, name: "LED 1" }
  ]);
  const [resistors, setResistors] = useState([
    { id: 1, sR: 25, sC: 3, eR: 25, eC: 6, scale: 1, ohms: 330, name: "Resistor 1" }
  ]);
  const [code, setCode] = useState(`import time\ntest = Pin(15, Pin.OUT)\n\nprint("Start")\nfor i in range(5):\n    test.value(1)\n    time.sleep(0.5)\n    test.value(0)\n    time.sleep(0.5)\nprint("Done")`);

  const [selectedHole, setSelectedHole] = useState(null);

  const [inputWire, setInputWire] = useState({ sR: 1, sC: 1, eR: 1, eC: 1, color: 'blue', name: 'Wire X' });
  const [inputLed, setInputLed] = useState({ sR: 1, sC: 1, eR: 2, eC: 1, name: 'LED X' });
  const [inputResistor, setInputResistor] = useState({ sR: 1, sC: 1, eR: 2, eC: 1, scale: 1.0, ohms: 330, name: 'Res X' });

  const [newResistorOhms, setNewResistorOhms] = useState(330);
  const [newWireColor, setNewWireColor] = useState('green');

  // --- ★ 回路成立チェック (Source to Sink Path Finding) ---
  const { activeIds, activeNodes } = useMemo(() => {
    const netMap = {}; 
    let netCount = 0;
    const getNetId = (holeId) => {
      if (netMap[holeId] === undefined) netMap[holeId] = netCount++;
      return netMap[holeId];
    };

    // 1. グラフ構築 (電源レール対応)
    const connAdj = {};
    const addConn = (id1, id2) => {
      if(!connAdj[id1]) connAdj[id1] = []; if(!connAdj[id2]) connAdj[id2] = [];
      connAdj[id1].push(id2); connAdj[id2].push(id1);
    };

    // 部品の接続
    const registerComp = (item) => {
      const h1 = getHoleId(item.sR, item.sC);
      const h2 = getHoleId(item.eR, item.eC);
      addConn(h1, h2);
    };
    wires.forEach(registerComp); resistors.forEach(registerComp); leds.forEach(registerComp);

    // ブレッドボード内部の接続 (横5穴 & 電源レール縦)
    // 本来はUnion-Find等でまとめるが、簡易的に「同じネットならつながっている」とするため
    // ここでは部品の端点ベースでグラフを作る。
    // ただし、同じ行(Row)の穴同士は自動的につながる必要がある。
    // -> 簡易化: グラフのノードを「穴ID」ではなく「NetID(行/レール単位)」にするのが正解だが、
    //    今の実装(HoleID)ベースだと、同じ行の穴を全結合する必要がある。
    //    → 計算量削減のため、部品の端点が含まれる行だけを「ハブ」として登録する。
    
    const rowNodes = {}; // "L-25" -> ["L-25"] (行ごとの穴リスト)
    // 電源レールも同様 "PL+" -> [...]
    
    const getGroupKey = (holeId) => {
      if (holeId.startsWith('P')) return holeId.split('-')[0]; // PL+, PR-
      const [side, rowStr] = holeId.split('-');
      return `${side}-${rowStr}`; // L-25
    };

    // 部品が刺さっている穴をグループ化
    const usedHoles = new Set();
    [...wires, ...leds, ...resistors].forEach(i => {
      usedHoles.add(getHoleId(i.sR, i.sC));
      usedHoles.add(getHoleId(i.eR, i.eC));
    });

    // 同じグループ(行/レール)内の穴同士を結ぶエッジを追加
    const groups = {};
    usedHoles.forEach(h => {
      const key = getGroupKey(h);
      if (!groups[key]) groups[key] = [];
      groups[key].push(h);
    });
    Object.values(groups).forEach(list => {
      for(let i=0; i<list.length-1; i++) {
        addConn(list[i], list[i+1]);
      }
    });


    // 2. ソース(GPIO High) と シンク(GND) の特定
    const sources = [];
    const sinks = [];
    usedHoles.forEach(holeId => {
      if (holeId.startsWith('P')) return; // 電源レールにPicoは刺さらない
      const [side, rowStr] = holeId.split('-');
      const row = parseInt(rowStr);
      const col = side === 'L' ? 1 : 6;
      const pin = getGpioFromHole(row, col);
      
      if (pin !== null && pinStates[pin]) sources.push(holeId);
      if (GND_ROWS.includes(row)) sinks.push(holeId);
    });

    // 3. BFS (Source -> ?)
    const powered = new Set();
    const queueP = [...sources];
    queueP.forEach(s => powered.add(s));
    while(queueP.length > 0) {
      const curr = queueP.shift();
      if(connAdj[curr]) {
        connAdj[curr].forEach(next => {
          if(!powered.has(next)) { powered.add(next); queueP.push(next); }
        });
      }
    }

    // 4. BFS (Sink <- ?)
    const grounded = new Set();
    const queueG = [...sinks];
    queueG.forEach(s => grounded.add(s));
    while(queueG.length > 0) {
      const curr = queueG.shift();
      if(connAdj[curr]) {
        connAdj[curr].forEach(next => {
          if(!grounded.has(next)) { grounded.add(next); queueG.push(next); }
        });
      }
    }

    // 5. 両方につながっている部品だけActive
    const activeSet = new Set();
    const check = (item) => {
      const h1 = getHoleId(item.sR, item.sC);
      const h2 = getHoleId(item.eR, item.eC);
      // 両端のどちらかがPowered、もう片方がGrounded... ではなく
      // 「両端ともPoweredかつGroundedな経路上にある」のが正しい
      // 簡易的に: 両端が (Powered AND Grounded) セットに含まれるか
      const p1 = powered.has(h1); const g1 = grounded.has(h1);
      const p2 = powered.has(h2); const g2 = grounded.has(h2);
      
      if ((p1 && g1) || (p2 && g2)) {
         // 少なくとも片方が有効な経路上にいればOKとみなす (直列回路ならこれで十分)
         activeSet.add(item.id);
      }
    };
    [...wires, ...leds, ...resistors].forEach(check);

    // 可視化用ノード
    const validNodes = new Set();
    powered.forEach(n => { if(grounded.has(n)) validNodes.add(n); });

    return { activeIds: activeSet, activeNodes: validNodes };

  }, [wires, leds, resistors, pinStates]);

  const isCompActive = (id) => activeIds.has(id);

  useEffect(() => {
    const saved = localStorage.getItem('pico_sim_data_v15'); // Version up
    if (saved) {
      try {
        const data = JSON.parse(saved);
        setWires(data.wires || []); setLeds(data.leds || []); setResistors(data.resistors || []); setCode(data.code || "");
      } catch(e) {}
    }
  }, []);
  useEffect(() => {
    localStorage.setItem('pico_sim_data_v15', JSON.stringify({ wires, leds, resistors, code }));
  }, [wires, leds, resistors, code]);

  const saveToFile = () => {
    const blob = new Blob([JSON.stringify({ wires, leds, resistors, code }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'pico_circuit.json'; a.click();
  };
  const loadFromFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = (ev) => {
      try {
        const d = JSON.parse(ev.target.result);
        setWires(d.wires); setLeds(d.leds); setResistors(d.resistors); setCode(d.code);
      } catch(e) { alert("Error"); }
    };
    r.readAsText(file);
  };
  const clearCircuit = () => { if(window.confirm("Clear circuit?")) { setWires([]); setLeds([]); setResistors([]); } };
  const clearCode = () => { if(window.confirm("Clear code?")) setCode(""); };

  const removeWire = (id) => setWires(wires.filter(w => w.id !== id));
  const removeLed = (id) => setLeds(leds.filter(l => l.id !== id));
  const removeResistor = (id) => setResistors(resistors.filter(r => r.id !== id));

  const startEdit = (item, type) => {
    setEditingId(item.id);
    setEditType(type);
    setToolMode(type); 
    setDraftStart(null);
    if (type === 'wire') setInputWire({ sR: item.sR, sC: item.sC, eR: item.eR, eC: item.eC, color: item.color, name: item.name });
    if (type === 'led') setInputLed({ sR: item.sR, sC: item.sC, eR: item.eR, eC: item.eC, name: item.name });
    if (type === 'resistor') setInputResistor({ sR: item.sR, sC: item.sC, eR: item.eR, eC: item.eC, scale: item.scale, ohms: item.ohms, name: item.name });
  };

  const cancelEdit = () => {
    setEditingId(null); setEditType(null); setDraftStart(null);
  };

  const handleHoleClick = (row, col) => {
    if (toolMode === 'cursor') {
      setSelectedHole({ row, col });
      return;
    }
    if (!draftStart) {
      setDraftStart({ row, col });
    } else {
      const sR = draftStart.row; const sC = draftStart.col;
      const eR = row; const eC = col;
      if (sR === eR && sC === eC) { setDraftStart(null); return; }

      if (editingId) {
        if (editType === 'wire') setWires(wires.map(w => w.id === editingId ? { ...w, sR, sC, eR, eC, color: inputWire.color, name: inputWire.name } : w));
        else if (editType === 'led') setLeds(leds.map(l => l.id === editingId ? { ...l, sR, sC, eR, eC, name: inputLed.name } : l));
        else if (editType === 'resistor') setResistors(resistors.map(r => r.id === editingId ? { ...r, sR, sC, eR, eC, ohms: Number(newResistorOhms), name: inputResistor.name } : r));
        setEditingId(null); setEditType(null);
      } else {
        if (toolMode === 'wire') setWires([...wires, { id: Date.now(), sR, sC, eR, eC, color: inputWire.color, level: 2, name: `Wire ${wires.length + 1}` }]);
        else if (toolMode === 'led') setLeds([...leds, { id: Date.now(), sR, sC, eR, eC, name: `LED ${leds.length + 1}` }]);
        else if (toolMode === 'resistor') setResistors([...resistors, { id: Date.now(), sR, sC, eR, eC, scale: 1.0, ohms: Number(newResistorOhms), name: `Resistor ${resistors.length + 1}` }]);
      }
      setDraftStart(null);
    }
  };

  const startHorizontalResize = useCallback((e) => { e.preventDefault(); const startX = e.clientX; const startWidth = leftPanelWidth; const onMouseMove = (moveEvent) => setLeftPanelWidth(Math.max(300, Math.min(800, startWidth + (moveEvent.clientX - startX)))); const onMouseUp = () => { document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); }; document.addEventListener('mousemove', onMouseMove); document.addEventListener('mouseup', onMouseUp); }, [leftPanelWidth]);
  const startVerticalResize = useCallback((e) => { e.preventDefault(); const startY = e.clientY; const startHeight = editorHeight; const onMouseMove = (moveEvent) => setEditorHeight(Math.max(200, Math.min(window.innerHeight - 200, startHeight + (moveEvent.clientY - startY)))); const onMouseUp = () => { document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); }; document.addEventListener('mousemove', onMouseMove); document.addEventListener('mouseup', onMouseUp); }, [editorHeight]);
  const getWireLabelColor = (color) => color === 'black' ? '#aaa' : color;

  return (
    <div style={{ height: '100vh', display: 'flex', overflow: 'hidden' }}>
      <div style={{ width: leftPanelWidth, display: 'flex', flexDirection: 'column', background: '#1e1e1e', color: '#fff' }}>
        {/* Editor Area */}
        <div style={{ height: editorHeight, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px', background: '#007acc', fontWeight: 'bold' }}>Selected: {selectedHole ? (selectedHole.col===0 ? "Power L+" : selectedHole.col===-1 ? "Power L-" : selectedHole.col===11 ? "Power R+" : selectedHole.col===12 ? "Power R-" : `Row ${selectedHole.row}, Col ${selectedHole.col}`) : "(Click a hole)"}</div>
          <div style={{ padding: '5px 10px', background: '#333', display: 'flex', gap: '10px', fontSize:'12px', alignItems:'center', flexWrap:'wrap' }}>
            <button onClick={saveToFile} style={{cursor:'pointer', border:'none', background:'#555', color:'white', padding:'4px 8px', borderRadius:'3px'}}>💾 Save</button>
            <label style={{cursor:'pointer', background:'#555', color:'white', padding:'4px 8px', borderRadius:'3px'}}>📂 Load <input type="file" accept=".json" onChange={loadFromFile} style={{display:'none'}} /></label>
            <span style={{width:'1px', height:'15px', background:'#666'}}></span>
            <button onClick={clearCircuit} style={{cursor:'pointer', color:'#ff9999', background:'none', border:'none'}}>🗑 Clear</button>
            <button onClick={clearCode} style={{cursor:'pointer', color:'#ff9999', background:'none', border:'none'}}>📄 Clear Code</button>
          </div>
          <div style={{ padding: '10px', background: '#252526', display: 'flex', gap: '10px' }}>
            <button onClick={() => run(code)} disabled={!ready} style={{ background: 'green', color: 'white', padding: '8px 20px', border:'none', cursor:'pointer', fontWeight:'bold', borderRadius:'4px' }}>▶ Run</button>
            <button onClick={stop} style={{ background: 'red', color: 'white', padding: '8px 20px', border:'none', cursor:'pointer', fontWeight:'bold', borderRadius:'4px' }}>■ Stop</button>
          </div>
          <textarea value={code} onChange={(e) => setCode(e.target.value)} spellCheck="false" style={{ flex: 1, background: '#111', color: '#eee', border: 'none', padding: '15px', resize: 'none', fontFamily: 'Consolas, monospace', fontSize: '14px', outline: 'none' }} />
          <div style={{ height: '100px', background: '#000', padding: '10px', fontSize: '12px', overflowY: 'auto', fontFamily: 'monospace', borderTop: '1px solid #444' }}>{logs.map((l, i) => <div key={i}>{l}</div>)}</div>
        </div>
        <div onMouseDown={startVerticalResize} style={{ height: '5px', background: '#444', cursor: 'row-resize', width: '100%', borderTop: '1px solid #333', borderBottom: '1px solid #333' }}></div>
        
        <div style={{ flex: 1, overflowY: 'auto', background: '#222' }}>
          <div style={{ padding: '15px' }}>
            <div style={{ fontWeight: 'bold', marginBottom: '10px', color:'#fff', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              Toolbox
              {editingId && <div style={{background:'orange', color:'black', padding:'2px 8px', borderRadius:'4px', fontSize:'11px'}}>EDITING...</div>}
            </div>
            
            <div style={{ display: 'flex', gap: '5px', marginBottom: '15px' }}>
              <button onClick={() => {setToolMode('cursor'); setDraftStart(null); cancelEdit();}} style={{ flex:1, padding:'8px', background: toolMode==='cursor' ? '#007acc':'#444', color:'white', border:'none', cursor:'pointer' }}>👆 Select</button>
              <button onClick={() => {setToolMode('wire'); setDraftStart(null); cancelEdit();}} style={{ flex:1, padding:'8px', background: toolMode==='wire' ? '#007acc':'#444', color:'white', border:'none', cursor:'pointer' }}>⚡ Wire</button>
              <button onClick={() => {setToolMode('led'); setDraftStart(null); cancelEdit();}} style={{ flex:1, padding:'8px', background: toolMode==='led' ? '#007acc':'#444', color:'white', border:'none', cursor:'pointer' }}>💡 LED</button>
              <button onClick={() => {setToolMode('resistor'); setDraftStart(null); cancelEdit();}} style={{ flex:1, padding:'8px', background: toolMode==='resistor' ? '#007acc':'#444', color:'white', border:'none', cursor:'pointer' }}>📏 Res</button>
            </div>

            <div style={{ padding:'10px', background:'#333', borderRadius:'4px', marginBottom:'15px' }}>
              {toolMode === 'cursor' && <div style={{color:'#aaa', fontSize:'12px'}}>Select item from list below to Edit/Delete.</div>}
              {toolMode === 'wire' && (
                <div>
                  <div style={{marginBottom:'5px', color:'#4ec9b0'}}>Wire Settings</div>
                  {editingId && (
                    <div style={{marginBottom:'5px'}}>
                       Name: <input type="text" value={inputWire.name} onChange={e=>setInputWire({...inputWire, name:e.target.value})} style={{width:'100px'}}/>
                    </div>
                  )}
                  <select value={newWireColor} onChange={e=>setNewWireColor(e.target.value)} style={{width:'100%', padding:'5px'}}>
                    <option value="green">Green</option><option value="black">Black</option><option value="red">Red</option><option value="blue">Blue</option><option value="yellow">Yellow</option>
                  </select>
                  <div style={{fontSize:'11px', marginTop:'5px', color:'#ccc'}}>Click Start -> End</div>
                </div>
              )}
              {toolMode === 'led' && (
                <div>
                  <div style={{marginBottom:'5px', color:'#ce9178'}}>LED Settings</div>
                  {editingId && (
                    <div style={{marginBottom:'5px'}}>
                       Name: <input type="text" value={inputLed.name} onChange={e=>setInputLed({...inputLed, name:e.target.value})} style={{width:'100px'}}/>
                    </div>
                  )}
                  <div style={{fontSize:'11px', color:'#ccc'}}>Click Anode(+) -> Cathode(-)</div>
                </div>
              )}
              {toolMode === 'resistor' && (
                <div>
                  <div style={{marginBottom:'5px', color:'#dcdcaa'}}>Resistor Settings</div>
                  {editingId && (
                    <div style={{marginBottom:'5px'}}>
                       Name: <input type="text" value={inputResistor.name} onChange={e=>setInputResistor({...inputResistor, name:e.target.value})} style={{width:'100px'}}/>
                    </div>
                  )}
                  <input type="number" value={newResistorOhms} onChange={e=>setNewResistorOhms(e.target.value)} style={{width:'60px', marginRight:'5px'}} /> Ω
                  <div style={{fontSize:'11px', marginTop:'5px', color:'#ccc'}}>Click Start -> End</div>
                </div>
              )}
            </div>

            <div style={{ borderTop:'1px solid #444', paddingTop:'10px' }}>
              <div style={{fontSize:'12px', color:'#888', marginBottom:'5px'}}>Components List</div>
              <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                {wires.map(w => (
                  <div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', padding:'4px', borderBottom:'1px solid #333', fontSize:'12px', background: editingId===w.id?'#444':'transparent', alignItems:'center' }}>
                    <span style={{color: getWireLabelColor(w.color), fontWeight:'bold'}}>{w.name}</span>
                    <div>
                      <button onClick={() => startEdit(w, 'wire')} style={{marginRight:'5px', cursor:'pointer', border:'none', background:'#555', color:'white', borderRadius:'3px', padding:'2px 6px'}}>✎</button>
                      <button onClick={() => removeWire(w.id)} style={{color:'white', border:'none', background:'#d33', cursor:'pointer', borderRadius:'3px', padding:'2px 6px'}}>x</button>
                    </div>
                  </div>
                ))}
                {leds.map(l => (
                  <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', padding:'4px', borderBottom:'1px solid #333', fontSize:'12px', background: editingId===l.id?'#444':'transparent', alignItems:'center' }}>
                    <span style={{color:'#ce9178', fontWeight:'bold'}}>{l.name}</span>
                    <div>
                      <button onClick={() => startEdit(l, 'led')} style={{marginRight:'5px', cursor:'pointer', border:'none', background:'#555', color:'white', borderRadius:'3px', padding:'2px 6px'}}>✎</button>
                      <button onClick={() => removeLed(l.id)} style={{color:'white', border:'none', background:'#d33', cursor:'pointer', borderRadius:'3px', padding:'2px 6px'}}>x</button>
                    </div>
                  </div>
                ))}
                {resistors.map(r => (
                  <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', padding:'4px', borderBottom:'1px solid #333', fontSize:'12px', background: editingId===r.id?'#444':'transparent', alignItems:'center' }}>
                    <span style={{color:'#dcdcaa', fontWeight:'bold'}}>{r.name} ({r.ohms}Ω)</span>
                    <div>
                      <button onClick={() => startEdit(r, 'resistor')} style={{marginRight:'5px', cursor:'pointer', border:'none', background:'#555', color:'white', borderRadius:'3px', padding:'2px 6px'}}>✎</button>
                      <button onClick={() => removeResistor(r.id)} style={{color:'white', border:'none', background:'#d33', cursor:'pointer', borderRadius:'3px', padding:'2px 6px'}}>x</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>
      </div>
      <div onMouseDown={startHorizontalResize} style={{ width: '5px', background: '#444', cursor: 'col-resize', height: '100%', borderLeft: '1px solid #333', borderRight: '1px solid #333' }}></div>
      
      <div style={{ flex: 1, background: '#111' }}>
        <Canvas camera={{ position: [5, 12, 5], fov: 45 }}>
          <color attach="background" args={['#222']} />
          <ambientLight intensity={0.6} />
          <directionalLight position={[5, 10, 5]} intensity={1} />
          <OrbitControls makeDefault target={[0, 0, 0]} />
          <Breadboard onHoleClick={handleHoleClick} selectedHole={selectedHole} draftStart={draftStart} activeNodes={activeNodes} isSimulating={isRunning} />
          <Pico pinStates={pinStates} />
          {wires.map(w => <CleanWire key={w.id} item={w} hasCurrent={isCompActive(w.id)} setHoverInfo={setHoverInfo} isSimulating={isRunning} />)}
          {leds.map(l => <LEDComponent key={l.id} item={l} hasCurrent={isCompActive(l.id)} setHoverInfo={setHoverInfo} isSimulating={isRunning} />)}
          {resistors.map(r => <ResistorComponent key={r.id} item={r} hasCurrent={isCompActive(r.id)} setHoverInfo={setHoverInfo} isSimulating={isRunning} />)}
          {hoverInfo && <Tooltip position={hoverInfo.pos} text={hoverInfo.text} />}
        </Canvas>
      </div>
    </div>
  );
}