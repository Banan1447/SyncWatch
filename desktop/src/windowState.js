const { screen } = require('electron');

module.exports = function createWindowStateKeeper(store, key, defaults) {
  let state = store.get(key, defaults);

  function isVisible(bounds) {
    const displays = screen.getAllDisplays();
    return displays.some(d => {
      return (
        bounds.x < d.bounds.x + d.bounds.width &&
        bounds.x + bounds.width > d.bounds.x &&
        bounds.y < d.bounds.y + d.bounds.height &&
        bounds.y + bounds.height > d.bounds.y
      );
    });
  }

  if (state.x !== undefined && !isVisible(state)) {
    state = defaults;
  }

  return {
    x: state.x,
    y: state.y,
    width: state.width || defaults.width,
    height: state.height || defaults.height,
    isMaximized: state.isMaximized || false,

    track(win) {
      const save = () => {
        if (!win.isMaximized() && !win.isMinimized()) {
          const bounds = win.getBounds();
          state = { ...bounds, isMaximized: false };
        } else {
          state = { ...state, isMaximized: win.isMaximized() };
        }
        store.set(key, state);
      };
      win.on('resize', save);
      win.on('move', save);
      win.on('close', save);
      win.on('maximize', save);
      win.on('unmaximize', save);
    },
  };
};
