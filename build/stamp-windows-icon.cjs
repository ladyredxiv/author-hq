const fs = require('node:fs');
const path = require('node:path');
const PELibrary = require('pe-library');
const ResEdit = require('resedit');

exports.default = async function stampWindowsIcon(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const iconPath = path.join(context.packager.projectDir, 'assets', 'icon.ico');

  const exe = PELibrary.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const resources = PELibrary.NtExecutableResource.from(exe);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));

  const existingGroups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  const groupIds = existingGroups.length > 0 ? existingGroups.map((group) => group.id) : [1];
  const langs = existingGroups.length > 0 ? existingGroups.map((group) => group.lang) : [1033];

  for (let index = 0; index < groupIds.length; index += 1) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries,
      groupIds[index],
      langs[index],
      iconFile.icons.map((item) => item.data)
    );
  }

  resources.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`Stamped Author HQ icon into ${exePath}`);
};
