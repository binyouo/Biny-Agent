import React, { type CSSProperties } from "react";

/** 图标与动态角色共用的矢量原稿；打包资源由它生成。 */
export function PocketSpiritArtwork({ id, dark = false, tile = false }: { id: string; dark?: boolean; tile?: boolean }): React.JSX.Element {
  const palette = {
    "--fold-shell-top": dark ? "#a4bdd8" : "#88a8c7",
    "--fold-shell": dark ? "#6e93bb" : "#54799f",
    "--fold-lining-light": dark ? "#e5e0f3" : "#e1deee",
    "--fold-lining": dark ? "#beb7d6" : "#b6b4ce",
    "--fold-inner-shadow": "#7f819f",
    "--fold-shadow": dark ? "#27384f" : "#33465f",
    "--fold-edge": "#eeeaf6",
    "--fold-crease": dark ? "#567da7" : "#45688d",
    "--fold-ink": "#26364c"
  } as CSSProperties;
  return (
    <svg className="fold-art" width="100%" height="100%" viewBox="0 0 320 320" aria-hidden="true" focusable="false" style={palette}>
      <defs>
        <linearGradient id={`${id}-shell`} x1=".2" y1="0" x2=".9" y2="1" gradientUnits="objectBoundingBox"><stop stopColor="var(--fold-shell-top)"/><stop offset="1" stopColor="var(--fold-shell)"/></linearGradient>
        <linearGradient id={`${id}-lining`} x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox"><stop stopColor="var(--fold-lining-light)"/><stop offset="1" stopColor="var(--fold-lining)"/></linearGradient>
        <radialGradient id={`${id}-pearl`} cx=".33" cy=".24" r=".8"><stop stopColor="#fff9e9"/><stop offset=".68" stopColor="#ffe4c5"/><stop offset="1" stopColor="#f6c5ac"/></radialGradient>
      </defs>
      <g transform={tile ? "translate(22.4 22.4) scale(.86)" : undefined}>
        {tile ? <rect x="10" y="10" width="300" height="300" rx="72" fill={dark ? "#202b3b" : "#edf0f4"} /> : null}
        <g className="fold-breathe">
          <g className="fold-pose">
            <path className="fold-back" fill={`url(#${id}-shell)`} d="M120 57 C148 36 184 44 218 63 C233 88 202 113 191 140 C186 155 218 172 239 190 C273 218 267 250 232 266 C198 282 112 282 80 264 C51 248 41 222 48 193 C57 151 89 81 120 57 Z"/>
            <path className="fold-cavity" fill="var(--fold-shadow)" d="M165 78 C191 79 214 98 201 123 C190 144 162 170 145 191 C125 216 133 237 163 247 C126 259 86 248 76 225 C63 196 94 154 121 125 C140 104 153 88 165 78 Z"/>
            <path fill="var(--fold-inner-shadow)" d="M128 189 C146 169 177 168 196 185 C218 206 205 238 182 250 C157 262 131 246 130 228 C148 226 158 208 128 189 Z"/>
            <g className="fold-pearl"><circle cx="145" cy="225" r="25" fill={`url(#${id}-pearl)`}/><ellipse cx="136" cy="213" rx="6.7" ry="5.4" fill="#fffdf7" transform="rotate(-28 136 213)"/></g>
            <g className="fold-cuff">
              <path fill={`url(#${id}-lining)`} d="M87 210 C81 231 109 242 143 243 C174 244 196 231 197 211 C198 193 186 179 173 175 C198 177 217 198 213 223 C209 251 181 267 144 270 C110 272 82 258 77 239 C73 227 77 217 87 210 Z"/>
              <path fill="var(--fold-edge)" opacity=".65" d="M87 210 C81 231 109 242 143 243 C174 244 196 231 197 211 C198 224 184 248 144 250 C112 252 87 240 83 226 C81 220 83 213 87 210 Z"/>
            </g>
            <g className="fold-head">
              <path fill={`url(#${id}-lining)`} d="M153 75 C173 69 203 75 224 91 C220 111 204 129 183 139 C164 148 143 154 125 158 C136 132 148 103 153 75 Z"/>
              <path fill="var(--fold-lining)" opacity=".55" d="M154 76 C176 74 205 81 224 91 C220 100 215 108 208 114 C185 103 172 91 154 76 Z"/>
              <g className="fold-eyes">
                <g className="fold-open-eyes" fill="var(--fold-ink)"><ellipse cx="162" cy="125" rx="5.4" ry="9.2" transform="rotate(14 162 125)"/><ellipse cx="203" cy="108" rx="5.4" ry="9.2" transform="rotate(14 203 108)"/></g>
                <g className="fold-closed-eyes" fill="none" stroke="var(--fold-ink)" strokeWidth="3.5" strokeLinecap="round"><path d="M155 124 Q161 132 168 124"/><path d="M196 108 Q202 116 209 108"/></g>
              </g>
              <g className="fold-hood">
                <path fill={`url(#${id}-shell)`} d="M55 199 C63 148 74 90 106 62 C132 35 159 36 187 44 C211 51 247 59 264 74 C278 86 272 98 254 99 C226 100 195 88 179 70 C163 98 138 131 112 151 C90 169 69 183 55 199 Z"/>
                <path fill="var(--fold-crease)" d="M179 70 C190 83 203 91 218 95 C201 97 187 94 174 85 Z"/>
              </g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
