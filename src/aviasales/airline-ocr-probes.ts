

export interface AirlineOcrProbe {
  readonly label: string;
  readonly re: RegExp;
}

export const AIRLINE_OCR_PROBES: readonly AirlineOcrProbe[] = Object.freeze([
  { label: 'Уральские авиалинии', re: /\bуральские\s+авиалинии\b/i },
  {
    label: 'Азербайджанские авиалинии',
    re: /\bазербайджанские\s+авиалинии\b/i,
  },
  { label: 'Турецкие авиалинии', re: /\bтурецкие\s+авиалинии\b/i },

  {
    label: 'S7 Airlines',
    re:
      /\bs7\b(?:\s*-?\s*air(?:lines)?)?|\bc7\b|\bc\s*-?\s*7\b[^\n]{0,10}(?:эйр|\bполёт\b|[Aa]ir\b)|[Сс]s7\b|\b(?:siberia|ciberia|сири|сибирь)\b|\bэйрлайн[^\n]{0,8}\bs7\b/i,
  },

  {
    label: 'Azur Air',
    re: /\bazur\s*-?\s*air\b|\bазур\s*-?\s*эйр\b/i,
  },
  {
    label: 'Pegasus',
    re: /\bpegasus\b|\bпегасус\b/i,
  },

  {
    label: 'Nord Wind',
    re: /\bnord\s*-?\s*wind\b|\bнордвинд\b/i,
  },

  {
    label: 'UTair',
    re: /\b(?:utair|ютэйр|ютайр)\b/i,
  },

  {
    label: 'Wizz Air',
    re: /\bwizz\s*-?\s*air\b|\bвизз\s*-?\s*эйр\b/i,
  },

  {
    label: 'Qatar Airways',
    re: /\bqatar\b(?:\s+airway)?|\bкатарские\s+авиалинии\b/i,
  },

  {
    label: 'Emirates',
    re: /\bemirates\b|\bэмирейтс\b|\bэмирейст\b/i,
  },

  {
    label: 'Fly Dubai',
    re: /\bfly\s*-?\s*dubai\b|\bфлай\s*-?\s*дубай\b/i,
  },

  {
    label: 'Air Astana',
    re: /\bair\s*-?\s*astana\b|\bавиакомпания\s+астана\b/i,
  },

  {
    label: 'Lufthansa',
    re: /\blufthansa\b|\bлюфтганза\b/i,
  },

  {
    label: 'KLM',
    re: /\bklm\b/i,
  },

  {
    label: 'Air France',
    re: /\bair\s*-?\s*france\b/i,
  },

  {
    label: 'Turkish Airlines',
    re: /\bturkish\s+airlines\b|\bturkish\b|\bтиш\s*эйрлайн\b|\bthy\b/i,
  },

  {
    label: 'LOT Polish Airlines',
    re:
      /\blot\b(?:\s+(?:polish\s+)?air(?:lines)?)?|\bлот\b\s*-?\s*польски/i,
  },

  {
    label: 'Brussels Airlines',
    re: /\bbrussels\s+airlines\b/i,
  },

  {
    label: 'Czech Airlines',
    re: /\bczech\s+airlines\b/i,
  },

  {
    label: 'Finnair',
    re: /\bfinnair\b|\bфиннэйр\b/i,
  },

  {
    label: 'British Airways',
    re: /\bbritish\s+airways\b/i,
  },

  {
    label: 'EgyptAir',
    re: /\begypt\s*air\b|\bэгипетские\s+авиалинии\b/i,
  },

  {
    label: 'Etihad Airways',
    re: /\betihad\b|\bэтихад\b|\bэйтихад\b/i,
  },

  {
    label: 'Hainan Airlines',
    re: /\bhainan\b(?:\s+air(?:lines|ways)?)?/i,
  },

  {
    label: 'Air China',
    re: /\bair\s*-?\s*china\b|\bэйр\s*-?\s*чин/i,
  },

  {
    label: 'China Southern Airlines',
    re:
      /\bchina\s+southern\b(?:\s+air(?:lines)?)?|\bchina\s+southern\s+эйрлайн\b/i,
  },

  {
    label: 'Saudia',
    re:
      /\bsaudia\b|\bсаудия\b|\bсауд\b\s*-?\s*арабски|\bсаудских\s+авиалинии\b/i,
  },

  {
    label: 'Oman Air',
    re: /\boman\s+air\b/i,
  },

  {
    label: 'IndiGo',
    re: /\bindigo\b|\bиндиг\b/i,
  },

  {
    label: 'Asiana Airlines',
    re:
      /\basiana\b(?:\s+-?\s*air(?:lines|way))?|\bOZ\b[^\n]{0,14}[Aa]ir(?:lines|way)?|\bOZ\s*-?\s*эйрлайн\b/i,
  },

  {
    label: 'Air Serbia',
    re: /\bair\s*-?\s*serbia\b/i,
  },

  {
    label: 'Aegean Airlines',
    re: /\baegean\b|\bэгейские\s+авиалинии\b/i,
  },

  {
    label: 'Belavia',
    re: /\bbelavia\b|\bбелавиа\b/i,
  },

  {
    label: 'Air Moldova',
    re:
      /\bair\s*-?\s*moldova\b|\bэйр\b\s*-?\s*молдов|\bэйрлайн[^\n]{0,8}\b(?:молдавия|маулдова)\b/i,
  },

  {
    label: 'Uzbekistan Airways',
    re:
      /\bUzAir\b|\bUz\b[^\n]{0,14}[Aa]ir(?:lines|way)?|\buzbekistan\b[^\n]{0,28}(эйрлайн|[Aa]ir(?:lines|way)?|\bUz\b[^\n]{0,8}[Aa]ir\b)|\b(?:Uzbekistan|Узбекистон)\s+[^\n]{0,24}(эйрлайн|[Aa]ir(?:lines|way)?)|узбек[^\n]{0,22}(?:авиалинии|эйрлайн|[Aa]ir)/i,
  },

  {
    label: 'Ukraine International Airlines',
    re:
      /\buia\b|\bМАУ\b|\bmau\b(?:\s*[.\-]\s*эйрлайн\b)?|\bukrain(?:e|ian)[^\n]{0,26}\b(?:intl\.?|international)\b[^\n]{0,26}(эйрлайн|[Aa]ir(?:lines)?)|\bукраински(?:е|\b)[^\n]{0,26}авиалинии\b/i,
  },

  {
    label: 'SAS Scandinavian',
    re: /\b(?:SAS\b|САС\b)(?:\s+скандинавиан)?|\bscandinavian\s+air(?:lines)?\b/i,
  },

  {
    label: 'Air Arabia',
    re:
      /\bair\s*-?\s*arabia\b|\bara?bia\s*-?\s*air\b|\bэйр\b\s*-?\s*арабия\b|\bэйрабия\b/i,
  },

  {
    label: 'Аэрофлот',
    re: /\b(?:аэрофлот|аерофлот|aeroflot)\b/i,
  },

  {
    label: 'Победа',
    re: /\b(?:победа|pobeda)\b/i,
  },

  {
    label: 'Авиакомпания Россия',
    re:
      /\brossiya\b|\bроссия\s*-?\s*эйрлайн\b|\bавиакомпания\s+[«\"]?\s*россия\s*[»\"]?\b/i,
  },

  {
    label: 'Smartavia',
    re:
      /\b(?:smartavia|смартавиа)\b|\b(?:nordavia|нордавия|норд\s*-?\s*авиа)\b/i,
  },

  {
    label: 'Авиакомпания Добролёт',
    re: /\bdobrolet\b|\bдобол[еёо]т\b/i,
  },

  {
    label: 'Red Wings',
    re: /\bred\s*wings\b|\bredwing\b|\bред\s*-?\s*винг\b/i,
  },

  {
    label: 'Yamal Airlines',
    re: /\byamal\b(?:\s+air(?:lines)?)?|\bямаль\b|\bямальские\s+авиалинии\b/i,
  },

  {
    label: 'Nordavia',
    re: /\bnordavia\b|\bнордавия\b/i,
  },

  {
    label: 'Авиа компания Аврора',
    re: /\bаврора\b|\bauro?ra\b/i,
  },

  {
    label: 'Yakutia Airlines',
    re: /\b(?:якутия|yakutia)\b/i,
  },

  {
    label: 'Алроса',
    re: /\balrosa\b|\bалроса\b/i,
  },

  {
    label: 'Руслайн',
    re: /\brus\s*[-]?\s*line\b|\bруслайн\b|\brusline\b/i,
  },

  {
    label: 'ИрАэро',
    re: /\bir\s*[-]?\s*aero\b|\bираеро\b|\bир\s*-?\s*аэро\b/i,
  },

  {
    label: 'Angara Airlines',
    re: /\bangara\b(?:\s+air)?|\bангарские\s+авиалинии\b|\bангар[^\n]{0,10}эйр\b/i,
  },

  {
    label: 'Северсталь',
    re: /\bseverstal\b|\bсеверсталь\b/i,
  },

  {
    label: 'IZHAVIA',
    re: /\bizhavia\b|\bижавиа\b/i,
  },

  {
    label: 'Азимут',
    re: /\bazimuth\b|\bазимут\b/i,
  },

  {
    label: 'UVT Aero',
    re: /\buvt\b(?:\s+[-]?aero)?|\bЮВТ\b/i,
  },

  {
    label: 'Ural Airlines',
    re:
      /\bural\b\s*-?\s*air(?:lines)?\b|\b(?:Ural|URAL)\s*[-]?\s*Air\b|\buralskaya\s+avia|\bурал[^\n]{0,28}(?:эйр|эйрлайн|лайн)\b|\bЮ\s*рал\b/i,
  },
]);

const UNICODE_WORD_BOUNDARY_FOR_DOM =
  '(?:(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_])|(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_]))';

function domInnerTextRegexFromProbe(re: RegExp): RegExp {
  let src = re.source;
  if (/\b/.test(src)) {
    src = src.replace(/\\b/g, UNICODE_WORD_BOUNDARY_FOR_DOM);
  }
  const flags = re.flags.includes('u') ? re.flags : `${re.flags}u`;
  // В режиме `u` последовательность \" в паттерне (в т.ч. внутри []) — Invalid escape; только \u0022.
  if (flags.includes('u')) {
    src = src.replace(/\\"/g, '\\u0022');
  }
  return new RegExp(src, flags);
}

/** Регексы для разбора `document.body.innerText` / текста Playwright. */
export const AIRLINE_DOM_INNERTEXT_PROBES: readonly AirlineOcrProbe[] = Object.freeze(
  AIRLINE_OCR_PROBES.map((p) => ({
    label: p.label,
    re: domInnerTextRegexFromProbe(p.re),
  })),
);
