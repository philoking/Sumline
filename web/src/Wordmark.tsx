/**
 * The app's name, drawn the way its logo draws it.
 *
 * A homage to the Redline BMX wordmark: heavy italic caps, packed tight, in a
 * red that carries an outline so it holds against either theme — and the last
 * letter running out into three speed bars. The bars are the part worth
 * stealing, because in a sheet of stacked lines they read as what the app is
 * rather than as decoration borrowed from a bicycle.
 *
 * Set in type rather than drawn as paths, and shipped as markup rather than as
 * an image, for the same reason the favicon is an inline SVG: the app carries
 * no image files, and a wordmark that is text stays sharp at any size and in
 * any theme without a second copy at 2x.
 */
export function Wordmark(props: { className?: string }) {
  return (
    <span className={props.className ? `wordmark ${props.className}` : 'wordmark'}>
      <span className="wordmark-name">Sumline</span>
      {/* Three, like the reference, and hidden from assistive tech: the name is
          beside them and "three bars" is not something to announce. */}
      <span className="wordmark-bars" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

/**
 * The mark on its own, for where a whole word will not fit.
 *
 * A tile rather than a smaller copy of the wordmark, because the two sit next
 * to each other in the bar: repeating the speed bars there would read as a
 * stutter rather than as one identity. The letter carries the lean and the
 * red, the wordmark carries the bars, and each is doing something the other
 * is not.
 *
 * The favicon in `index.html` draws the same thing and has to be changed with
 * it; it is static HTML and cannot import this.
 */
export function Mark() {
  return (
    <svg
      className="app-mark"
      viewBox="0 0 32 32"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="7" fill="#e4002b" />
      <text
        x="16"
        y="24"
        className="app-mark-letter"
        textAnchor="middle"
        fontSize="24"
        fontWeight="900"
        fontStyle="italic"
      >
        S
      </text>
    </svg>
  );
}
