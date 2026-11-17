import {
  Autoformat,
  BlockQuote,
  Bold,
  CodeBlock,
  Essentials,
  Heading,
  Image,
  Italic,
  Link,
  List,
  Markdown,
  Paragraph,
  Table,
  TableToolbar,
  ClassicEditor,
} from 'ckeditor5';
import 'ckeditor5/ckeditor5.css';

export function createMarkdownEditor(element, initialData) {
  return ClassicEditor.create({
    attachTo: element,
    licenseKey: 'GPL',
    plugins: [
      Autoformat,
      BlockQuote,
      Bold,
      CodeBlock,
      Essentials,
      Heading,
      Image,
      Italic,
      Link,
      List,
      Markdown,
      Paragraph,
      Table,
      TableToolbar,
    ],
    toolbar: [
      'undo', 'redo', '|', 'heading', '|', 'bold', 'italic', 'link', '|',
      'bulletedList', 'numberedList', 'blockQuote', 'codeBlock', 'insertTable',
    ],
    table: {
      contentToolbar: ['tableColumn', 'tableRow', 'mergeTableCells'],
    },
    root: {
      initialData,
      placeholder: 'Write Markdown…',
    },
  });
}
