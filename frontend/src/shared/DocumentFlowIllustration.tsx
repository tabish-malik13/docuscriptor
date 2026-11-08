export function DocumentFlowIllustration() {
  return (
    <svg className="hero-art" viewBox="0 0 520 246" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="cardFill" x1="70" x2="300" y1="46" y2="210" gradientUnits="userSpaceOnUse">
          <stop stopColor="#31234d"/><stop offset="1" stopColor="#201832"/>
        </linearGradient>
        <linearGradient id="paperFill" x1="320" x2="455" y1="32" y2="207" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fdfbff"/><stop offset="1" stopColor="#dcd1ff"/>
        </linearGradient>
        <filter id="shadow" x="-25%" y="-30%" width="155%" height="175%">
          <feDropShadow dx="0" dy="12" stdDeviation="12" floodColor="#100722" floodOpacity=".37"/>
        </filter>
      </defs>
      <path d="M31 179h109m264-83h77M79 37h97m221 166h82" stroke="#b2a1ff" strokeOpacity=".22" strokeDasharray="4 6"/>
      <circle cx="52" cy="179" r="3" fill="#9980ff"/><circle cx="474" cy="96" r="3" fill="#b8a7ff"/>
      <path d="M466 55v13m-6.5-6.5h13M93 193v12m-6-6h12M432 213v11m-5.5-5.5h11" stroke="#b29bff" strokeOpacity=".76" strokeWidth="1.4" strokeLinecap="round"/>
      <g filter="url(#shadow)" transform="rotate(-9 183 122)">
        <rect x="88" y="57" width="190" height="128" rx="12" fill="url(#cardFill)" stroke="#7662ae"/>
        <path d="M88 84h190" stroke="#7662ae" strokeOpacity=".55"/>
        <circle cx="102" cy="71" r="2.6" fill="#a994e8"/><circle cx="111" cy="71" r="2.6" fill="#76649f"/><circle cx="120" cy="71" r="2.6" fill="#76649f"/>
        <text x="139" y="74" fill="#ccbcec" fontSize="8" fontFamily="monospace">document-fields.json</text>
        <g fontSize="11" fontFamily="monospace" fill="#d3c1ff">
          <text x="108" y="108">{'{'}</text>
          <text x="117" y="126">"title": <tspan fill="#b5e7d1">{'"{{ title }}"'}</tspan>,</text>
          <text x="117" y="144">"date": <tspan fill="#ffcda0">{'"{{ date }}"'}</tspan></text>
          <text x="108" y="162">{'}'}</text>
        </g>
      </g>
      <path d="M267 123h73" stroke="#9d80fd" strokeWidth="1.5" strokeDasharray="4 4"/>
      <rect x="278" y="107" width="33" height="33" rx="10" fill="#7656ef" stroke="#b49afc"/>
      <path d="M287 123.5h14m-5-5 5 5-5 5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <g transform="rotate(10 384 125)" filter="url(#shadow)">
        <path d="M336 51h79l23 23v118a8 8 0 0 1-8 8h-94a8 8 0 0 1-8-8V59a8 8 0 0 1 8-8Z" fill="#6f52d7" stroke="#ad94ff" transform="translate(13 5)"/>
        <path d="M336 51h79l23 23v118a8 8 0 0 1-8 8h-94a8 8 0 0 1-8-8V59a8 8 0 0 1 8-8Z" fill="url(#paperFill)" stroke="#fff" strokeOpacity=".9"/>
        <path d="M415 51v17a6 6 0 0 0 6 6h17" fill="#bcaae9"/>
        <rect x="343" y="70" width="26" height="24" rx="6" fill="#d7c8ff"/>
        <path d="M352 77h8v10h-8zM354 81h4m-4 3h4" stroke="#7152d8" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round"/>
        <rect x="343" y="106" width="62" height="5" rx="2.5" fill="#7252d7"/>
        <rect x="343" y="117" width="38" height="4" rx="2" fill="#a890df"/>
        <rect x="343" y="134" width="78" height="34" rx="4" fill="#e5dbff" stroke="#c2afea"/>
        <path d="M343 145h78m-78 11h78m-22-22v34" stroke="#c2afea"/>
        <rect x="343" y="179" width="30" height="4" rx="2" fill="#a890df"/>
      </g>
      <g transform="translate(403 160)" filter="url(#shadow)">
        <rect width="57" height="26" rx="7" fill="#f9f6ff" stroke="#d8c9ff"/>
        <circle cx="12" cy="13" r="3" fill="#7758e9"/>
        <text x="21" y="16" fill="#5b429c" fontFamily="monospace" fontWeight="700" fontSize="9">DOCX</text>
      </g>
    </svg>
  )
}
