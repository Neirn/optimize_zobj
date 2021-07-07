import { SmartBuffer } from 'smart-buffer';

interface IDisplayListInfo {
    data: Buffer,
    dependencies: Set<number>,
    offset: number
}

export function optimize(zobj: Buffer, DLoffsets: Set<number>, rebase: number = 0, segment = 0x06) {

    let textures = new Map<number, Buffer>();
    let vertices = new Map<number, Buffer>();
    let matrices = new Map<number, Buffer>();
    let displayLists = new Array<IDisplayListInfo>();

    // first pass: gather all relevant offsets for display lists, textures, palettes, and vertex data
    DLoffsets.forEach((val) => {

        if (val % 8 !== 0) {
            throw new Error("Display List Offset 0x" + val.toString(16) + " is not byte-aligned!");
        }

        let isEndOfDL = false;
        let displayList = new SmartBuffer();
        let deps = new Set<number>();

        for (let i = val; i < zobj.byteLength && !isEndOfDL; i += 8) {

            // console.log("Proc 0x" + i.toString(16));

            let opcode = zobj[i];
            let seg = zobj[i + 4];
            let loWord = zobj.readUInt32BE(i + 4);


            switch (opcode) {

                // end of display list, self-explanatory
                case 0xDF:
                    isEndOfDL = true;
                    break;

                // branch to new display list, so add to list
                case 0xDE:

                    if (zobj[i + 1] === 0x01) {
                        isEndOfDL = true;
                    }

                    if (seg === segment) {
                        DLoffsets.add(loWord & 0x00FFFFFF);
                        deps.add(loWord & 0x00FFFFFF);
                    }
                    break;

                // vertex data
                case 0x01:
                    if (seg === segment) {
                        let vtxStart = loWord & 0x00FFFFFF;
                        let vtxLen = zobj.readUInt16BE(i + 1);

                        // don't write same data twice
                        let vtxEntry = vertices.get(vtxStart);

                        if (vtxEntry !== undefined && vtxLen < vtxEntry.length) {
                            break;
                        }

                        let vtxDat = Buffer.alloc(vtxLen);

                        zobj.copy(vtxDat, 0, vtxStart, vtxStart + vtxLen);

                        vertices.set(vtxStart, vtxDat);
                    }
                    break;

                case 0xDA: // push matrix
                    if (seg === segment) {

                        let mtxStart = loWord & 0x00FFFFFF;

                        let mtxEntry = matrices.get(mtxStart);

                        if (mtxEntry === undefined) {
                            if (mtxStart + 0x40 > zobj.length) {    // matrices are always 0x40 bytes long
                                throw new Error("Invalid matrix offset at 0x" + i.toString());
                            }

                            let mtxBuf = Buffer.alloc(0x40);

                            zobj.copy(mtxBuf, 0, mtxStart, mtxStart + 0x40);

                            matrices.set(mtxStart, mtxBuf);
                        }
                    }
                    break;

                case 0xFD:  // handle textures
                    // Don't ask me how this works

                    if (seg === segment) {

                        let textureType = (zobj[i + 1] >> 3) & 0x1F;

                        // console.log("Texture Type: 0x" + textureType.toString(16));

                        let bitSize = 4 * Math.pow(2, textureType & 0x3);
                        let bytes = bitSize / 8;

                        // console.log("bit size: 0x" + bitSize.toString(16));

                        let texOffset = loWord & 0x00FFFFFF;

                        // Palette macro always includes E8 afterward?
                        let isPalette = zobj[i + 8] === 0xE8;
                        // console.log(isPalette);

                        let stopSearch = false;

                        let size = -1;

                        for (let j = i + 8; j < zobj.byteLength && !stopSearch && size === -1; j += 8) {

                            // console.log("Current opcode: 0x" + zobj[j].toString(16));

                            let loWordJ = zobj.readUInt32BE(j + 4);

                            // console.log("Low word J: 0x" + loWordJ.toString(16));

                            switch (zobj[j]) {
                                case 0xDF:
                                case 0xFD:
                                    console.log("DF or FD reached too early when looking for texture")
                                    stopSearch = true;
                                    break;

                                case 0xDE:
                                    if (zobj[j + 1] === 0x01) {
                                        console.log("DE01 reached too early when looking for texture")
                                        stopSearch = true;
                                    }
                                    break;

                                case 0xF0:

                                    if (isPalette) {
                                        // console.log("Calculating palette size?")
                                        size = ((loWordJ & 0x00FFF000) >> 14) + 1;
                                        // console.log("Size: 0x" + size.toString(16));
                                    }
                                    else throw new Error("Mismatched palette and FD command at 0x" + i.toString(16));
                                    stopSearch = true;

                                    if (size > 256) {
                                        throw new Error("Invalid number of colors in TLUT");
                                    }
                                    break;

                                case 0xF3:
                                    if (!isPalette) {
                                        size = ((loWordJ & 0x00FFF000) >> 12) + 1;
                                        // console.log("Non-paletted texture size: 0x" + size.toString(16));
                                    }
                                    else throw new Error("Mismatched non-palette and FD command at 0x" + i.toString(16));
                                    stopSearch = true;
                                    break;

                                default:
                                    break;
                            }
                        }

                        // console.log("size: 0x" + size.toString(16));

                        if (size === -1) {
                            throw new Error("Could not find texture size for FD command at 0x" + i.toString(16));
                        }

                        let dataLen = bytes * size;

                        // console.log("dataLen: 0x" + dataLen.toString(16));

                        // console.log("Texture Address: 0x" + texOffset.toString(16) + "- 0x" + (texOffset + dataLen).toString(16));

                        if (texOffset + dataLen > zobj.byteLength) {
                            throw new Error("Texture referenced at 0x" + i.toString(16) + " not in range of zobj!");
                        }

                        let texDat = textures.get(texOffset);

                        if (!texDat || texDat.byteLength < dataLen) {
                            let texBuf = Buffer.alloc(dataLen);

                            zobj.copy(texBuf, 0, texOffset, texOffset + dataLen);

                            textures.set(texOffset, texBuf);
                        }
                    }
                    break;

                default:
                    break;
            }

            displayList.writeBuffer(zobj.slice(i, i + 8));
        }

        displayLists.push({
            data: displayList.toBuffer(),
            dependencies: deps,
            offset: val
        });
    });

    // Create the new zobj
    // start by writing all of the textures, vertex data, and matrices
    let optimizedZobj = new SmartBuffer();

    let oldTex2New = new Map<number, number>();

    textures.forEach((tex, originalOffset) => {

        let newOffset = optimizedZobj.length;

        oldTex2New.set(originalOffset, newOffset);

        // console.log("Tex: 0x" + originalOffset.toString(16) + " -> 0x" + newOffset.toString(16));

        optimizedZobj.writeBuffer(tex);

    });

    let oldVer2New = new Map<number, number>();
    vertices.forEach((tex, originalOffset) => {

        let newOffset = optimizedZobj.length;

        oldVer2New.set(originalOffset, newOffset);

        optimizedZobj.writeBuffer(tex);

        // console.log("Vert: 0x" + originalOffset.toString(16) + " -> 0x" + newOffset.toString(16));

    });

    let oldMtx2New = new Map<number, number>();

    matrices.forEach((mtx, originalOffset) => {
        let newOffset = optimizedZobj.length;

        oldMtx2New.set(originalOffset, newOffset);

        optimizedZobj.writeBuffer(mtx);
    });

    // repoint the display lists
    // sort to make sure that the display lists called by DE are already in the zobj
    let oldDL2New = new Map<number, number>();

    displayLists.sort((a, b) => {
        return (a.dependencies.size - b.dependencies.size) * -1;    // sort in descending order
    });

    while (displayLists.length !== 0) {
        let currentData = displayLists.pop();

        if (!currentData) {
            throw new Error("Something went wrong when relocating display lists!");
        }

        if (currentData.dependencies.size !== 0) {
            throw new Error("Non-relocated display list referenced.");
        }

        let dl = currentData.data;

        oldDL2New.set(currentData.offset, optimizedZobj.length);

        for (let i = 0; i < dl.byteLength; i += 8) {
            let opcode = dl[i];
            let seg = dl[i + 4];
            let loWord = dl.readUInt32BE(i + 4);

            if (seg === segment) {

                // console.log("Proc 0x" + i.toString(16));
                // console.log("Opcode: 0x" + opcode.toString(16));
                // console.log("Low Word: 0x" + loWord.toString(16));

                switch (opcode) {   // do repoint
                    case 0x01:
                        let vertEntry = oldVer2New.get(loWord & 0x00FFFFFF);

                        if (vertEntry === undefined) {
                            throw new Error("Non-relocated vertex data referenced.");
                        }

                        dl.writeUInt32BE(0x06000000 + vertEntry + rebase, i + 4);
                        break;

                    case 0xDA:
                        let mtxEntry = oldMtx2New.get(loWord & 0x00FFFFFF);

                        if (mtxEntry === undefined) {
                            throw new Error("Non-relocated matrix data referenced.");
                        }

                        dl.writeUInt32BE(0x06000000 + mtxEntry + rebase, i + 4);
                        break;

                    case 0xFD:
                        let texEntry = oldTex2New.get(loWord & 0x00FFFFFF);

                        if (texEntry === undefined) {
                            throw new Error("Non-relocated texture data referenced.");
                        }

                        dl.writeUInt32BE(0x06000000 + texEntry + rebase, i + 4);
                        break;

                    case 0xDE:
                        let dlEntry = oldDL2New.get(loWord & 0x00FFFFFF);

                        if (dlEntry === undefined)
                            throw new Error("Non-relocated display list referenced.");

                        dl.writeUInt32BE(0x06000000 + dlEntry + rebase, i + 4);
                        break;

                    default:
                        break;
                }
            }
        }

        // console.log("DL: 0x" + currentData.offset.toString(16) + " -> 0x" + optimizedZobj.length.toString(16));

        optimizedZobj.writeBuffer(dl);

        // remove this display list as a dependency so that we can sort again
        displayLists.forEach((dat) => {
            // shut up typescript. I verified that this isn't undefined earlier
            dat.dependencies.delete((currentData as IDisplayListInfo).offset)
        });

        // re-sort
        displayLists.sort((a, b) => {   // need to re-sort in case last element no longer has 0 dependencies while others do
            return (a.dependencies.size - b.dependencies.size) * -1;    // sort in descending order
        });
    }

    oldDL2New.forEach((newOff, oldOff) => {
        oldDL2New.set(oldOff, newOff + rebase);
    });

    return {
        zobj: optimizedZobj.toBuffer(),
        oldOffs2NewOffs: oldDL2New
    }
}