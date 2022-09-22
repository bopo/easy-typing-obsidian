import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, Workspace, WorkspaceLeaf, TFile } from 'obsidian';
import { EditorState, Extension, StateField, Transaction, TransactionSpec, Text } from '@codemirror/state';
import { EasyTypingSettingTab, EasyTypingSettings, DEFAULT_SETTINGS, PairString, ConvertRule } from "./settings"
import { EditorView, ViewUpdate } from '@codemirror/view';
import { posToOffset, offsetToPos, ruleStringList2RuleList, getTypeStrOfTransac } from './utils'
import { ArticleParser, LineFormater } from './core'

export default class EasyTypingPlugin extends Plugin {
	settings: EasyTypingSettings;
	SelectionReplaceMap: Map<string, PairString>;
	SymbolPairsMap: Map<string, string>;
	BasicConvRules: ConvertRule[];
	FW2HWSymbolRules: ConvertRule[];
	ContentParser: ArticleParser;
	Formater: LineFormater;
	DeleteRules: ConvertRule[];
	PrevActiveMarkdown: string;

	async onload() {
		await this.loadSettings();
		this.SelectionReplaceMap = new Map([
			["【", {left:"[", right:"]"}], ["￥", {left:"$", right:"$"}], ["·", {left:"`", right:"`"}],
			["《", {left:"《", right:"》"}], ["“", {left:"“", right:"”"}], ["”", {left:"“", right:"”"}], ["（", {left:"（", right:"）"}],
			["<", {left:"<", right:">"}], ["「", {left:"[", right:"]"}], ["『", {left:"[", right:"]"}]                                
			]);
		this.SymbolPairsMap = new Map<string, string>();
		let SymbolPairs = ["【】", "（）", "<>", "《》", "“”", "‘’", "「」", "『』"]
		for (let pairStr of SymbolPairs) this.SymbolPairsMap.set(pairStr.charAt(0), pairStr.charAt(1));
		let BasicConvRuleStringList: Array<[string, string]> = [['··|', '`|`'], ["`·|`", "```|\n```"],
		["【【|】", "[[|]]"], ['【【|', "[[|]]"], ['￥￥|', '$|$'], ['$￥|$', "$$\n|\n$$"], ["$$|$", "$$\n|\n$$"], ['$$|', "$|$"],
		[">》|", ">>|"], ['\n》|', "\n>|"], [" 》|", " >|"], ["\n、|", "\n/|"], [' 、|', " /|"]];
		this.BasicConvRules = ruleStringList2RuleList(BasicConvRuleStringList);
		let FW2HWSymbolRulesStrList: Array<[string, string]> = [["。。|", ".|"], ["！！|", "!|"], ["；；|", ";|"], ["，，|", ",|"],
		["：：|", ":|"], ['？？|', '?|'], ['、、|', '/|'],
		["》》|", ">|"], ["《《|》", "<|"], ['《《|', "<|"]];
		this.FW2HWSymbolRules = ruleStringList2RuleList(FW2HWSymbolRulesStrList);

		let DeleteRulesStrList: Array<[string, string]> = [["$|$", "|"], ['```|\n```', '|'], ['==|==', '|'], ['$$\n|\n$$', "|"]];
		this.DeleteRules = ruleStringList2RuleList(DeleteRulesStrList);
		
		this.PrevActiveMarkdown = "";

		this.ContentParser = new ArticleParser()
		this.Formater = new LineFormater();

		this.registerEditorExtension([
			EditorState.transactionFilter.of(this.transactionFilterPlugin),
			EditorView.updateListener.of(this.viewUpdatePlugin)
		]);

		this.addCommand({
			id: "easy-typing-format-article",
			name: "format current article",
			editorCallback: (editor: Editor, view: MarkdownView) =>{
				this.formatArticle(editor);
			},
			hotkeys: [{
				modifiers: ['Ctrl', 'Shift'],
				key: "s"
			}],
		});

		this.addCommand({
			id: "easy-typing-format-selection",
			name: "format selected text or current line",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.formatSelectionOrCurLine(editor);
			},
			hotkeys: [{
				modifiers: ['Ctrl', 'Shift'],
				key: "l"
			}],
		});

		this.addCommand({
			id: "easy-typing-insert-codeblock",
			name: "insert code block w/wo selection",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.convert2CodeBlock(editor);
			},
			hotkeys: [{
				modifiers: ['Ctrl', 'Shift'],
				key: "n"
			}],
		});

		this.addCommand({
			id: "easy-typing-format-switch",
			name: "switch autoformat",
			callback: () => this.switchAutoFormatting(),
			hotkeys: [{
				modifiers: ['Ctrl'],
				key: "tab"
			}],
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new EasyTypingSettingTab(this.app, this));

		this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf: WorkspaceLeaf) => {
			if (leaf.view.getViewType()=='markdown'){
				let editor = this.getEditor();
				if (editor === null) return;
				let file = this.app.workspace.getActiveFile();
				if (this.PrevActiveMarkdown!=file.path)
				{
					this.ContentParser.parseNewArticle(editor.getValue());
					this.PrevActiveMarkdown = file.path;
					new Notice("EasyTyping: Parse New Active Article: "+file.path);
				}
			}
		}));

		// this.registerEvent(this.app.workspace.on('file-open', (file: TFile | null) => {
		// 	if (file != null) {
		// 		let editor = this.getEditor();
		// 		if (editor === null) return;
		// 		this.ContentParser.parseNewArticle(editor.getValue());
		// 		if (this.settings.debug) {
		// 			new Notice("EasyTyping: Parse New Article: " + file.vault.getName() + '/' + file.path);
		// 			// if (this.settings.debug) this.ContentParser.print();
		// 		}
		// 	}
		// }));
	}

	onunload() {
	}

	transactionFilterPlugin = (tr: Transaction): TransactionSpec | readonly TransactionSpec[] => {
		const changes: TransactionSpec[] = [];
		if (!tr.docChanged) return tr;

		let changeTypeStr = getTypeStrOfTransac(tr);
		tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
			let changedStr = tr.startState.sliceDoc(fromA, toA);
			let insertedStr = inserted.sliceString(0);
			if (this.settings.debug)
			{
				console.log("TransactionFilter catch change:",changeTypeStr, fromA, toA, fromB, toB, insertedStr);
			}
			// ========== Selection Replace ============
			if (this.settings.SelectionEnhance) {
				if ((changeTypeStr == 'input.type'||changeTypeStr=="input.type.compose") && fromA != toA && fromB + 1 === toB) {
					if (this.SelectionReplaceMap.has(insertedStr)) {
						changes.push({ changes: { from: fromA, insert: this.SelectionReplaceMap.get(insertedStr)?.left }, userEvent: "EasyTyping.change" })
						changes.push({ changes: { from: toA, insert: this.SelectionReplaceMap.get(insertedStr)?.right }, userEvent: "EasyTyping.change" })
						tr = tr.startState.update(...changes);
						return tr;
					}
				}
			}

			// ========== delete pair symbol ============
			if (changeTypeStr === "delete.backward" && this.settings.SymbolAutoPairDelete) {
				if (this.SymbolPairsMap.has(changedStr) && this.SymbolPairsMap.get(changedStr) === tr.startState.sliceDoc(toA, toA + 1)) {
					changes.push({ changes: { from: fromA, to: toA + 1 }, userEvent: "EasyTyping.change" });
					tr = tr.startState.update(...changes);
					return tr;
				}
				for (let rule of this.DeleteRules)
				{
					let left = tr.startState.doc.sliceString(toA - rule.before.left.length, toA);
					let right = tr.startState.doc.sliceString(toA, toA + rule.before.right.length);
					if (left === rule.before.left && right === rule.before.right) {
						changes.push({
							changes: {
								from: toA - rule.before.left.length,
								to: toA + rule.before.right.length,
								insert: rule.after.left + rule.after.right
							},
							selection: { anchor: toA - rule.before.left.length + rule.after.left.length },
							userEvent: "EasyTyping.change"
						});
						tr = tr.startState.update(...changes);
						return tr;
					}
				}
			}

			// 通常单字输入
			if ((changeTypeStr == 'input.type'||changeTypeStr=="input.type.compose") && fromA === toA && fromB + 1 === toB) {
				// if (this.settings.debug) console.log("Input.type => ", insertedStr)
				// =========== basic convert rules ============
				// not support undo and redo
				if (this.settings.BaseObEditEnhance) {
					for (let rule of this.BasicConvRules) {
						if (insertedStr != rule.before.left.charAt(rule.before.left.length - 1)) continue;
						// 处理文档第 0 行
						if (rule.before.left.charAt(0) === '\n' && offsetToPos(tr.state.doc, fromA).line === 0 && toB - rule.before.left.length + 1 === 0) {
							let left = tr.state.doc.sliceString(toB - rule.before.left.length + 1, toB);
							let right = tr.state.doc.sliceString(toB, toB + rule.before.right.length);
							if (left === rule.before.left.substring(1) && right === rule.before.right) {
								changes.push({
									changes: {
										from: toA - rule.before.left.length + 2,
										to: toA + rule.before.right.length,
										insert: rule.after.left.substring(1) + rule.after.right
									},
									selection: { anchor: toA - rule.before.left.length + rule.after.left.length + 1 },
									userEvent: "EasyTyping.change"
								});
								tr = tr.startState.update(...changes);
								return tr;
							}
						}
						// 通常情况处理
						else {
							let left = tr.state.doc.sliceString(toB - rule.before.left.length, toB);
							let right = tr.state.doc.sliceString(toB, toB + rule.before.right.length);
							if (left === rule.before.left && right === rule.before.right) {
								changes.push({
									changes: {
										from: toA - rule.before.left.length + 1,
										to: toA + rule.before.right.length,
										insert: rule.after.left + rule.after.right
									},
									selection: { anchor: toA - rule.before.left.length + rule.after.left.length + 1 },
									userEvent: "EasyTyping.change"
								});
								tr = tr.startState.update(...changes);
								return tr;
							}
						}
					}
				}

				if (this.settings.FW2HWEnhance) {
					for (let rule of this.FW2HWSymbolRules) {
						if (insertedStr != rule.before.left.charAt(rule.before.left.length - 1)) continue;
						let left = tr.state.doc.sliceString(toB - rule.before.left.length, toB);
						let right = tr.state.doc.sliceString(toB, toB + rule.before.right.length);
						if (left === rule.before.left && right === rule.before.right) {
							changes.push({
								changes: {
									from: toA - rule.before.left.length + 1,
									to: toA + rule.before.right.length,
									insert: rule.after.left + rule.after.right
								},
								selection: { anchor: toA - rule.before.left.length + rule.after.left.length + 1 },
								userEvent: "EasyTyping.change"
							});
							tr = tr.startState.update(...changes);
							return tr;
						}
					}
				}

				// ================ auto pair =================
				// let PairValidSet = new Set(["", " ","\n"])
				// let charAfterCursor = tr.startState.sliceDoc(toA, toA+1);
				if (this.settings.SymbolAutoPairDelete)
				{
					if (this.SymbolPairsMap.has(insertedStr)) {
						changes.push({
							changes: { from: fromA, to: toA, insert: insertedStr + this.SymbolPairsMap.get(insertedStr) },
							selection: { anchor: fromA + 1 },
							userEvent: "EasyTyping.change"
						});
						tr = tr.startState.update(...changes);
						return tr;
					}
					// handle autopair for "”" and "’"
					if (insertedStr === '”' || insertedStr === '’') {
						let tempStr = insertedStr === "”" ? "“”" : "‘’";
						changes.push({
							changes: { from: fromA, to: toA, insert: tempStr },
							selection: { anchor: fromA + 1 },
							userEvent: "EasyTyping.change"
						});
						tr = tr.startState.update(...changes);
						return tr;
					}
				}
			}
		})
		return tr;
	}

	viewUpdatePlugin = (update: ViewUpdate) => {
		// if (this.settings.debug) console.log("-------ViewUpdate---------");
		let formatLineFlag = true;
		let mainSelection = update.view.state.selection.asSingle().main;
		if (mainSelection.anchor != mainSelection.head) formatLineFlag = false;

		if (update.docChanged) {
			// if (this.settings.debug) console.log("-----ViewUpdateWChange-----");
			let tr = update.transactions[0]
			let changeType = getTypeStrOfTransac(tr);
			tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
				let insertedStr = inserted.sliceString(0);
				let changedStr = tr.startState.doc.sliceString(fromA, toA);
				if (this.settings.debug)
					console.log("ViewUpdate Catch Change: Type: " + changeType + ", ", fromA, toA, changedStr, fromB, toB, insertedStr);

				// 每次改动都判断是否需要重新解析全文
				let reparseRegEx = /[`$\n]/gm;
				let newArticle = update.view.state.doc.sliceString(0, update.view.state.doc.length);
				if (reparseRegEx.test(insertedStr) || reparseRegEx.test(changedStr)) {
					let updateLineStart = offsetToPos(update.view.state.doc, fromA).line;
					this.ContentParser.reparse(newArticle, updateLineStart);
					if (this.settings.debug) {
						new Notice("EasyTyping: Reparse At Line: " + String(updateLineStart));
						// this.ContentParser.print();
					}
				}
				this.ContentParser.updateContent(newArticle)

				// if (changeType == 'input.type' || changeType == "input" || changeType=="input.type.compose") {
				// 	// ========== FullWSymbol2HalfWSymbol convert rules=======
				// 	// support undo and redo
				// 	if (this.settings.FW2HWEnhance) {
				// 		for (let rule of this.FW2HWSymbolRules) {
				// 			if (insertedStr != rule.before.left.charAt(rule.before.left.length - 1)) continue;
				// 			let left = update.view.state.doc.sliceString(toB - rule.before.left.length, toB);
				// 			let right = update.view.state.doc.sliceString(toB, toB + rule.before.right.length);
				// 			if (left === rule.before.left && right === rule.before.right) {
				// 				update.view.dispatch({
				// 					changes: {
				// 						from: toB - rule.before.left.length,
				// 						to: toB + rule.before.right.length,
				// 						insert: rule.after.left + rule.after.right
				// 					},
				// 					selection: { anchor: toB - rule.before.left.length + rule.after.left.length },
				// 					userEvent: "EasyTyping.change"
				// 				})
				// 				return;
				// 			}
				// 		}
				// 	}
				// }

				if (changeType == 'input.type' || changeType == "input") {
					if (this.settings.AutoFormat && formatLineFlag && this.ContentParser.isTextLine(offsetToPos(update.view.state.doc, fromB).line)) {
						let changes = this.Formater.formatLineOfDoc(update.view.state.doc, this.settings, fromB, mainSelection.anchor, insertedStr);
						if (changes != null) {
							update.view.dispatch(...changes[0]);
							update.view.dispatch(changes[1]);
							return;
						}
					}

				}
				else if (changeType === 'input.type.compose') {
					// 找到光标位置，比较和 toB 的位置是否相同，相同且最终插入文字为中文，则为中文输入结束的状态
					let cursor = update.view.state.selection.asSingle().main;
					let ChineseRegExp = /[\u4e00-\u9fa5]/;
					if (cursor.anchor === cursor.head && cursor.anchor === toB && ChineseRegExp.test(insertedStr)) {
						// let curCh = offsetToPos(update.view.state.doc, cursor.anchor).ch;
						// if (this.settings.debug) new Notice("EasyTyping: 中文输入结束");
						if (this.settings.AutoFormat && formatLineFlag && this.ContentParser.isTextLine(offsetToPos(update.view.state.doc, fromB).line)) {
							let changes = this.Formater.formatLineOfDoc(update.view.state.doc, this.settings, fromB, toB, insertedStr);
							if (changes != null) {
								update.view.dispatch(...changes[0]);
								update.view.dispatch(changes[1]);
								return;
							}
						}
					}
				}
			})

		}
	}

	formatArticle = (editor:Editor): void => {
		if (this.ContentParser.ArticleStructure.length == 0) return;
		let lineCount = editor.lineCount();
		for (let i = 0; i < lineCount; i++) {
			this.formatOneLine(editor, i);
		}
		this.ContentParser.updateContent(editor.getValue());
		new Notice("EasyTyping: Format Article Done!");
	}

	formatSelectionOrCurLine = (editor: Editor): void => {
		if (!editor.somethingSelected() || editor.getSelection() === '') {
			let lineNumber = editor.getCursor().line;
			this.formatOneLine(editor, lineNumber);
			return;
		}
		let selection = editor.listSelections()[0];
		let begin = selection.anchor.line;
		let end = selection.head.line;
		if (begin > end) {
			let temp = begin;
			begin = end;
			end = temp;
		}
		for (; begin <= end; begin++) {
			this.formatOneLine(editor, begin);
		}
		this.ContentParser.updateContent(editor.getValue());
	}

	formatOneLine = (editor:Editor, lineNumber: number): void => {
		if (this.ContentParser.isTextLine(lineNumber)) {
			let oldLine = editor.getLine(lineNumber);
			let newLine = this.Formater.formatLine(oldLine, this.settings, oldLine.length)[0];
			if (oldLine != newLine) {
				editor.replaceRange(newLine, { line: lineNumber, ch: 0 }, { line: lineNumber, ch: oldLine.length });
				editor.setCursor({ line: lineNumber, ch: editor.getLine(lineNumber).length });
			}
		}
		return;
	}

	switchAutoFormatting()
    {
        this.settings.AutoFormat = this.settings.AutoFormat? false:true;
        let status = this.settings.AutoFormat?'on':'off';
        new Notice('EasyTyping: Autoformat is '+ status +'!');
    }

	convert2CodeBlock(editor: Editor)
	{
		if (this.settings.debug) console.log("----- EasyTyping: insert code block-----");
		if(editor.somethingSelected && editor.getSelection()!="")
		{
			let selected = editor.getSelection();
			let selectedRange = editor.listSelections()[0];
			let anchor = selectedRange.anchor;
			let head = selectedRange.head;

			let replacement = "```\n"+selected+"\n```";
			// make sure anchor < head
			if (anchor.line > head.line || (anchor.line==head.line && anchor.ch>head.ch))
			{
				let temp = anchor;
				anchor = head;
				head = temp;
			}
			let dstLine = anchor.line;
			if (anchor.ch!=0)
			{
				replacement = '\n' + replacement;
				dstLine += 1;
			}
			if (head.ch!=editor.getLine(head.line).length)
			{
				replacement = replacement + '\n';
			}
			editor.replaceSelection(replacement);
			editor.setCursor({line: dstLine, ch:3});
			this.ContentParser.reparse(editor.getValue(), anchor.line);
		}
		else{
			let cs = editor.getCursor();
			let replace = "```\n```";
			let dstLine = cs.line;
			if (cs.ch!=0){
				replace = "\n"+replace;
				dstLine += 1;
			}
			if (cs.ch!=editor.getLine(cs.line).length)
			{
				replace = replace + '\n';
			}
			editor.replaceRange(replace, cs);
			editor.setCursor({line: dstLine, ch:3});
			this.ContentParser.reparse(editor.getValue(), cs.line);
		}
		
	}

	getEditor = (): Editor | null => {
		let editor = null;
		let markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (markdownView) {
			editor = markdownView.editor;
		}
		if (editor === null) console.log('can\'t get editor');
		return editor;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}