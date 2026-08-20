import Icon from './Icon.js'

/**
 * One search field for the whole application — streamers, VODs, clips, POVs.
 * It carries its own icon, its own clear button, and Escape clears rather than
 * closing whatever contains it.
 */
export default function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  label,
  autoFocus
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label?: string
  autoFocus?: boolean
}): JSX.Element {
  return (
    <div className="ui-search">
      <Icon name="search" size={14} />
      <input
        className="ui-input"
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value !== '') {
            e.stopPropagation()
            onChange('')
          }
        }}
      />
      {value !== '' && (
        <button type="button" className="ui-search-clear" aria-label="Clear search" onClick={() => onChange('')}>
          <Icon name="close" size={13} />
        </button>
      )}
    </div>
  )
}
