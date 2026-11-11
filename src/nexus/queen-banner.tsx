// @ts-nocheck
import React from 'react';
import { Figure, lookFor } from './robot';

/** Deriv Queen card artwork: a crowned robot with a pink visor, a bar chart on the left and the trade type on the right. */
export const QueenBanner = ({ seed, accent, kind }: { seed: number; accent: string; kind: 'over' | 'under' | 'even' | 'odd' | 'rise' | 'fall' }) => {
    const uid = `qb${seed}`;
    const upward = kind === 'over' || kind === 'rise' || kind === 'even';
    const look = { ...lookFor(seed, '#ff9ccf'), antenna: 0 };
    const dots = Array.from({ length: 6 * 10 }, (_, i) => ({ x: 16 + (i % 10) * 32 + (Math.floor(i / 10) % 2) * 16, y: 14 + Math.floor(i / 10) * 32 }));
    return (
        <svg viewBox='0 0 320 200' preserveAspectRatio='xMidYMid slice' role='img' aria-label='Queen robot'>
            <defs>
                <linearGradient id={`${uid}bg`} x1='0' y1='0' x2='1' y2='1'><stop offset='0' stopColor='#142450' /><stop offset='0.6' stopColor='#2c3f86' /><stop offset='1' stopColor='#7a3a78' /></linearGradient>
                <radialGradient id={`${uid}gl`} cx='50%' cy='45%' r='50%'><stop offset='0' stopColor='#ff9ccf' stopOpacity='0.55' /><stop offset='1' stopColor='#6495ed' stopOpacity='0' /></radialGradient>
                <linearGradient id={`${uid}cr`} x1='0' y1='0' x2='1' y2='1'><stop offset='0' stopColor='#cfe0ff' /><stop offset='0.55' stopColor={accent} /><stop offset='1' stopColor='#ff9ccf' /></linearGradient>
            </defs>
            <rect width='320' height='200' fill={`url(#${uid}bg)`} />
            {dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r='1.8' fill='#fff' opacity='0.14' />)}
            <circle cx='160' cy='92' r='98' fill={`url(#${uid}gl)`} />
            <g transform='translate(60 22)' className='nx-robot'>
                <Figure look={look} uid={uid} />
                <path d='M72 40 70 14l16 12 14-20 14 20 16-12-2 26z' fill={`url(#${uid}cr)`} stroke='#fff' strokeOpacity='0.8' strokeWidth='1.6' strokeLinejoin='round' />
                <circle cx='70' cy='13' r='3.6' fill='#ffd6ec' /><circle cx='100' cy='5' r='4' fill='#ffd6ec' /><circle cx='130' cy='13' r='3.6' fill='#ffd6ec' />
            </g>
            <g>
                <rect x='12' y='66' width='60' height='50' rx='14' fill='rgba(10,16,40,.72)' stroke='#8fb4ff' strokeWidth='1.5' />
                {[0, 1, 2, 3, 4].map(i => { const h = 14 + ((seed + i * 3) % 5) * 7; return <rect key={i} x={22 + i * 9} y={104 - h} width='6' height={h} rx='3' fill={i % 2 ? '#8fb4ff' : '#ff9ccf'} />; })}
                <rect x='248' y='66' width='60' height='50' rx='14' fill='rgba(10,16,40,.72)' stroke='#ff9ccf' strokeWidth='1.5' />
                <text x='278' y='88' textAnchor='middle' fontSize='18' fill='#ff9ccf'>{upward ? '▲' : '▼'}</text>
                <text x='278' y='107' textAnchor='middle' fontSize='11' fontWeight='700' fill='#fff' letterSpacing='1'>{kind.toUpperCase()}</text>
            </g>
        </svg>
    );
};
