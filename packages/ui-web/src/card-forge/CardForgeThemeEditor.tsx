'use client';

const PRESET_COLORS = [
  '#ff6b9d', '#ef4444', '#f59e0b', '#10b981',
  '#3b82f6', '#8b5cf6', '#ec4899', '#06b6d4',
];

export function CardForgeThemeEditor({ color, onChange }: { color: string; onChange: (value: string) => void }) {
  return (
    <section className="card-forge-panel rounded-2xl p-5 space-y-4">
      <h2 className="text-lg font-semibold text-[var(--app-text)]">主题色</h2>
      <div className="flex flex-wrap gap-2">
        {PRESET_COLORS.map((preset) => {
          const selected = color.toLowerCase() === preset;
          const label = `主题色 ${preset}`;
          return (
            <button
              key={preset}
              type="button"
              aria-label={label}
              title={label}
              aria-pressed={selected}
              onClick={() => onChange(preset)}
              className={`w-8 h-8 rounded-full border-2 transition-transform hover:scale-110 ${selected ? 'border-white' : 'border-transparent'}`}
              style={{
                backgroundColor: preset,
                boxShadow: selected ? `0 0 0 2px ${preset}` : 'none',
              }}
            />
          );
        })}
        <label className="w-8 h-8 rounded-full border-2 border-gray-300 dark:border-gray-600 cursor-pointer flex items-center justify-center overflow-hidden relative">
          <input
            type="color"
            value={color}
            onChange={(e) => onChange(e.target.value)}
            className="opacity-0 absolute w-8 h-8"
            aria-label="自定义主题色"
          />
          <span className="text-xs">+</span>
        </label>
      </div>
    </section>
  );
}
